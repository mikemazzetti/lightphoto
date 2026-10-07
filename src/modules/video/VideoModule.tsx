/**
 * Video workspace (Premiere Pro "Editing" layout):
 *   ┌ Source / Effect Controls ┬ Program monitor ┐
 *   ├ Project / Effects / Hist ┼ Timeline   ┬ dB ┤
 * The project lives in a module-level store (state/store.ts); GL, media elements and the audio
 * graph live in the Program monitor's Player and are torn down on unmount.
 */
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useBridge, takeVideoInbox } from '@/app/bridge';
import { isTyping, useCommands, useKeymap } from '@/app/commands';
import { api } from '@/platform/api';
import { toast } from '@/state/app';
import { cx } from '@/ui/controls';
import { checkMissing, importPaths } from './engine/media';
import * as A from './state/actions';
import { newProject, openProject, saveProject } from './state/projectFile';
import { flushAutosave, getState, redo, restoreAutosave, undo, useVideo, FocusPanel } from './state/store';
import { transport } from './state/transport';
import { Timeline, timelineApi } from './timeline/Timeline';
import { AudioMeters } from './ui/AudioMeters';
import { openSequenceSettings, openSpeedDialog } from './ui/dialogs';
import { EffectControls } from './ui/EffectControls';
import { openExportDialog } from './ui/ExportDialog';
import { ProgramMonitor } from './ui/ProgramMonitor';
import { EffectsPanel, HistoryPanel, importDialog, ProjectPanel } from './ui/ProjectPanel';
import { SourceMonitor, sourceApi } from './ui/SourceMonitor';
import './video.css';

interface LayoutSizes {
  top: number; // fraction of height for the top row
  tl: number; // px width of the top-left panel
  bl: number; // px width of the bottom-left panel
}
const LAYOUT_KEY = 'lp:video-layout';
function loadLayout(): LayoutSizes {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null');
    if (v && typeof v.top === 'number') return v;
  } catch {
    /* ignore */
  }
  return { top: 0.52, tl: 520, bl: 380 };
}

function Splitter({ dir, onDrag, onEnd }: { dir: 'v' | 'h'; onDrag: (d: number) => void; onEnd: () => void }) {
  return (
    <div
      className={cx('vid-split', dir)}
      onPointerDown={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        let last = dir === 'v' ? e.clientX : e.clientY;
        const move = (ev: PointerEvent) => {
          const p = dir === 'v' ? ev.clientX : ev.clientY;
          onDrag(p - last);
          last = p;
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          onEnd();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
    />
  );
}

function Frame<T extends string>({ id, tabs, active, onTab, children, style, right }: { id: FocusPanel; tabs: { id: T; label: ReactNode }[]; active: T; onTab?: (t: T) => void; children: ReactNode; style?: React.CSSProperties; right?: ReactNode }) {
  const focused = useVideo((s) => s.focus === id);
  return (
    <div
      className={cx('vid-panel', focused && 'focused')}
      style={style}
      onPointerDownCapture={() => {
        if (getState().focus !== id) useVideo.setState({ focus: id });
      }}
    >
      <div className="vid-tabs">
        {tabs.map((t) => (
          <div key={t.id} className={cx('vid-tab', t.id === active && 'active')} onClick={() => onTab?.(t.id)}>
            {t.label}
          </div>
        ))}
        <div className="spacer" />
        {right}
      </div>
      <div className="vid-panel-body">{children}</div>
    </div>
  );
}

// Guards against handling the same command twice (keydown + native menu accelerator).
let lastCmd = { id: '', t: 0 };
function once(id: string, fn: () => void) {
  const now = performance.now();
  if (lastCmd.id === id && now - lastCmd.t < 150) return;
  lastCmd = { id, t: now };
  fn();
}

export default function VideoModule() {
  const [layout, setLayout] = useState(loadLayout);
  const rootRef = useRef<HTMLDivElement>(null);
  const topLeftTab = useVideo((s) => s.topLeftTab);
  const bottomLeftTab = useVideo((s) => s.bottomLeftTab);
  const sourceName = useVideo((s) => s.project.media.find((m) => m.id === s.sourceId)?.name);
  const seqName = useVideo((s) => s.project.seq.name);
  const restored = useVideo((s) => s.restored);
  const inbox = useBridge((s) => s.video);
  const filePath = useVideo((s) => s.filePath);
  const dirty = useVideo((s) => s.project !== s.savedProject);
  const projectName = useVideo((s) => s.project.name);

  // Restore autosave + analyse media once.
  useEffect(() => {
    const firstMount = !getState().restored;
    void restoreAutosave().then(() => {
      void checkMissing();
      transport.seek(getState().playhead);
      if (firstMount && getState().project.seq.clips.length) setTimeout(() => timelineApi.fit?.(), 50);
    });
    const flush = () => flushAutosave();
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flushAutosave();
      transport.pause();
    };
  }, []);

  // Cross-module hand-off ("Send to Video").
  useEffect(() => {
    if (!restored) return;
    const items = takeVideoInbox();
    if (!items.length) return;
    void importPaths(items.map((i) => i.path)).then((media) => {
      if (media.length) {
        toast(`Added ${media.length} item${media.length > 1 ? 's' : ''} to the project`, 'success');
        useVideo.setState({ bottomLeftTab: 'project', binSelection: media.map((m) => m.id) });
      }
    });
  }, [inbox, restored]);

  useEffect(() => {
    api.setTitle(`LightPhoto Studio — Video — ${projectName}${dirty ? ' •' : ''}`);
  }, [projectName, dirty, filePath]);

  const saveLayout = () => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* ignore */
    }
  };

  // DOM clipboard events (the native Edit menu's copy/paste roles fire these).
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (isTyping(e.target) || isTyping(document.activeElement)) return;
      once('copy', () => A.copySelection());
      e.preventDefault();
    };
    const onCut = (e: ClipboardEvent) => {
      if (isTyping(e.target) || isTyping(document.activeElement)) return;
      once('cut', () => A.cutSelection());
      e.preventDefault();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target) || isTyping(document.activeElement)) return;
      once('paste', () => A.pasteAtPlayhead());
      e.preventDefault();
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, []);

  useCommands({
    'video:import': () => void importDialog(),
    'file:new': () => void newProject(),
    'file:open': () => once('open', () => void openProject()),
    'file:save': () => once('save', () => void saveProject(false)),
    'file:saveAs': () => once('saveAs', () => void saveProject(true)),
    'file:export': () => once('export', () => void openExportDialog()),
    'edit:undo': () => once('undo', undo),
    'edit:redo': () => once('redo', redo),
    'edit:selectAll': () => once('selectAll', A.selectAll),
    'edit:deselect': () => once('deselect', A.deselectAll),
    'view:zoomIn': () => timelineApi.zoomBy?.(1.5),
    'view:zoomOut': () => timelineApi.zoomBy?.(1 / 1.5),
    'view:fit': () => timelineApi.fit?.(),
  });

  const src = () => getState().focus === 'source' && getState().sourceId !== null;
  const seekRel = (n: number) => () => {
    if (src()) sourceApi.step?.(n);
    else A.step(n);
  };

  useKeymap({
    space: () => (src() ? sourceApi.toggle?.() : transport.toggle()),
    k: () => (src() ? sourceApi.shuttle?.(0) : transport.pause()),
    j: () => (src() ? sourceApi.shuttle?.(-1) : A.shuttle(-1)),
    l: () => (src() ? sourceApi.shuttle?.(1) : A.shuttle(1)),
    i: () => (src() ? sourceApi.markIn?.() : A.setSeqInOut('in')),
    o: () => (src() ? sourceApi.markOut?.() : A.setSeqInOut('out')),
    'alt+x': () => (src() ? sourceApi.clearMarks?.() : A.setSeqInOut('clear')),
    'shift+i': () => {
      const s = getState().project.seq;
      if (s.inPoint !== null) transport.seek(s.inPoint);
    },
    'shift+o': () => {
      const s = getState().project.seq;
      if (s.outPoint !== null) transport.seek(Math.max(0, s.outPoint - 1));
    },
    arrowleft: seekRel(-1),
    arrowright: seekRel(1),
    'shift+arrowleft': seekRel(-5),
    'shift+arrowright': seekRel(5),
    'alt+arrowleft': () => A.nudgeSelection(-1),
    'alt+arrowright': () => A.nudgeSelection(1),
    'shift+alt+arrowleft': () => A.nudgeSelection(-5),
    'shift+alt+arrowright': () => A.nudgeSelection(5),
    arrowup: () => A.gotoEdit(-1),
    arrowdown: () => A.gotoEdit(1),
    home: () => (src() ? sourceApi.home?.() : transport.seek(0)),
    end: () => (src() ? sourceApi.end?.() : transport.seek(Math.max(...getState().project.seq.clips.map((c) => c.start + c.duration), 0))),
    v: () => useVideo.setState({ tool: 'select' }),
    b: () => useVideo.setState({ tool: 'ripple' }),
    c: () => useVideo.setState({ tool: 'razor' }),
    s: () => useVideo.setState((s) => ({ snapping: !s.snapping })),
    m: () => A.addMarker(),
    'mod+k': () => A.splitAtPlayhead(),
    'shift+mod+k': () => {
      // Split all tracks regardless of selection.
      useVideo.setState({ selection: [], selectedTracks: [] });
      A.splitAtPlayhead();
    },
    delete: () => (getState().focus === 'project' ? void A.removeMedia(getState().binSelection) : A.deleteSelection(false)),
    backspace: () => (getState().focus === 'project' ? void A.removeMedia(getState().binSelection) : A.deleteSelection(false)),
    'shift+delete': () => A.deleteSelection(true),
    'shift+backspace': () => A.deleteSelection(true),
    'alt+delete': () => A.deleteSelection(true),
    'alt+backspace': () => A.deleteSelection(true),
    'shift+e': () => A.toggleEnable(),
    'mod+c': () => once('copy', () => A.copySelection()),
    'mod+x': () => once('cut', () => A.cutSelection()),
    'mod+v': () => once('paste', () => A.pasteAtPlayhead()),
    ',': () => {
      const s = getState();
      if (s.focus === 'timeline' && s.selection.length) A.nudgeSelection(-1);
      else A.sourceEdit('insert');
    },
    '.': () => {
      const s = getState();
      if (s.focus === 'timeline' && s.selection.length) A.nudgeSelection(1);
      else A.sourceEdit('overwrite');
    },
    '=': () => timelineApi.zoomBy?.(1.5),
    '-': () => timelineApi.zoomBy?.(1 / 1.5),
    '\\': () => timelineApi.fit?.(),
    ';': () => A.liftExtract(false),
    "'": () => A.liftExtract(true),
    'mod+d': () => A.applyTransitionAtPlayhead('crossDissolve'),
    'shift+d': () => A.applyDefaultTransitions('crossDissolve'),
    // (⌘R is Speed/Duration in Premiere but it's the native View › Reload accelerator here.)
    'alt+r': () => void openSpeedDialog(A.selectedClips()),
    'mod+z': () => once('undo', undo),
    'shift+mod+z': () => once('redo', redo),
    'mod+y': () => once('redo', redo),
    'mod+a': () => once('selectAll', A.selectAll),
    'shift+mod+a': () => once('deselect', A.deselectAll),
    'mod+i': () => void importDialog(),
    'mod+s': () => once('save', () => void saveProject(false)),
    'shift+mod+s': () => once('saveAs', () => void saveProject(true)),
    'shift+mod+e': () => once('export', () => void openExportDialog()),
    'mod+o': () => once('open', () => void openProject()),
    escape: () => {
      if (transport.playing) transport.pause();
      else A.deselectAll();
    },
  });

  const resizeTop = (d: number) => {
    const h = rootRef.current?.clientHeight ?? 800;
    setLayout((l) => ({ ...l, top: Math.max(0.2, Math.min(0.8, l.top + d / h)) }));
  };

  return (
    <div className="vid" ref={rootRef}>
      <div className="vid-row" style={{ height: `${layout.top * 100}%` }}>
        <Frame
          id={topLeftTab === 'source' ? 'source' : 'effectControls'}
          tabs={[
            { id: 'source', label: `Source${sourceName ? ': ' + sourceName : ''}` },
            { id: 'effectControls', label: 'Effect Controls' },
          ]}
          active={topLeftTab}
          onTab={(t) => useVideo.setState({ topLeftTab: t })}
          style={{ width: layout.tl, flex: '0 0 auto' }}
        >
          {topLeftTab === 'source' ? <SourceMonitor /> : <EffectControls />}
        </Frame>
        <Splitter dir="v" onDrag={(d) => setLayout((l) => ({ ...l, tl: Math.max(280, Math.min(window.innerWidth - 360, l.tl + d)) }))} onEnd={saveLayout} />
        <Frame id="program" tabs={[{ id: 'program', label: `Program: ${seqName}` }]} active="program" style={{ flex: 1 }} right={<SeqSettingsButton />}>
          <ProgramMonitor />
        </Frame>
      </div>
      <Splitter dir="h" onDrag={resizeTop} onEnd={saveLayout} />
      <div className="vid-row" style={{ flex: 1 }}>
        <Frame
          id={bottomLeftTab === 'project' ? 'project' : 'effects'}
          tabs={[
            { id: 'project', label: 'Project' },
            { id: 'effects', label: 'Effects' },
            { id: 'history', label: 'History' },
          ]}
          active={bottomLeftTab}
          onTab={(t) => useVideo.setState({ bottomLeftTab: t })}
          style={{ width: layout.bl, flex: '0 0 auto' }}
        >
          {bottomLeftTab === 'project' ? <ProjectPanel /> : bottomLeftTab === 'effects' ? <EffectsPanel /> : <HistoryPanel />}
        </Frame>
        <Splitter dir="v" onDrag={(d) => setLayout((l) => ({ ...l, bl: Math.max(220, Math.min(window.innerWidth - 420, l.bl + d)) }))} onEnd={saveLayout} />
        <Frame id="timeline" tabs={[{ id: 'tl', label: `Timeline: ${seqName}` }]} active="tl" style={{ flex: 1 }}>
          <Timeline />
        </Frame>
        <div className="vid-panel vid-meter-panel">
          <AudioMeters />
        </div>
      </div>
    </div>
  );
}

function SeqSettingsButton() {
  return (
    <button type="button" className="btn small ghost" style={{ height: 20, fontSize: 10.5 }} title="Sequence settings" onClick={() => void openSequenceSettings()}>
      Sequence Settings
    </button>
  );
}
