import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from '@/platform/api';
import { ModuleId, useApp } from '@/state/app';
import { loadCatalog, flushCatalog } from '@/state/catalog';
import { Icon, IconName } from '@/ui/Icon';
import { cx, Kbd, Spinner } from '@/ui/controls';
import { Modal, OverlayHost, TaskIndicator } from '@/ui/overlays';
import { handleKeyDown, handleMenuAction, isMac, shortcutLabel, useCommands, useKeymap } from './commands';
import { gpuInfo } from './gpuInfo';

const LibraryModule = lazy(() => import('@/modules/library/LibraryModule'));
const DevelopModule = lazy(() => import('@/modules/develop/DevelopModule'));
const EditorModule = lazy(() => import('@/modules/editor/EditorModule'));
const VideoModule = lazy(() => import('@/modules/video/VideoModule'));

const MODULES: { id: ModuleId; label: string; icon: IconName; key: string }[] = [
  { id: 'library', label: 'Library', icon: 'library', key: 'mod+alt+1' },
  { id: 'develop', label: 'Develop', icon: 'develop', key: 'mod+alt+2' },
  { id: 'editor', label: 'Edit', icon: 'editor', key: 'mod+alt+3' },
  { id: 'video', label: 'Video', icon: 'video', key: 'mod+alt+4' },
];

export function App() {
  const module = useApp((s) => s.module);
  const setModule = useApp((s) => s.setModule);
  const shortcutsOpen = useApp((s) => s.shortcutsOpen);
  const aboutOpen = useApp((s) => s.aboutOpen);

  useEffect(() => {
    void loadCatalog();
    window.addEventListener('keydown', handleKeyDown);
    const off = api.onMenu(handleMenuAction);
    const stopDrop = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', stopDrop);
    window.addEventListener('drop', stopDrop);
    const beforeUnload = () => flushCatalog();
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('dragover', stopDrop);
      window.removeEventListener('drop', stopDrop);
      window.removeEventListener('beforeunload', beforeUnload);
      off();
    };
  }, []);

  useEffect(() => {
    api.setTitle(`LightPhoto Studio — ${MODULES.find((m) => m.id === module)?.label}`);
  }, [module]);

  useCommands({
    'module:library': () => setModule('library'),
    'module:develop': () => setModule('develop'),
    'module:editor': () => setModule('editor'),
    'module:video': () => setModule('video'),
    'app:shortcuts': () => useApp.setState({ shortcutsOpen: true }),
    'app:preferences': () => useApp.setState({ aboutOpen: true }),
  });
  useKeymap({
    'mod+alt+1': 'module:library',
    'mod+alt+2': 'module:develop',
    'mod+alt+3': 'module:editor',
    'mod+alt+4': 'module:video',
    'mod+/': 'app:shortcuts',
  });

  return (
    <div className="app">
      <div className={cx('titlebar', api.isElectron && (isMac ? 'mac' : 'win'))}>
        <div className="brand">
          <div className="brand-mark" />
          LightPhoto Studio
        </div>
        <div className="module-switch">
          {MODULES.map((m) => (
            <button key={m.id} className={cx(m.id === module && 'active')} onClick={() => setModule(m.id)} title={`${m.label} (${shortcutLabel(m.key)})`}>
              <Icon name={m.icon} size={14} />
              {m.label}
            </button>
          ))}
        </div>
        <div className="titlebar-right">
          <TaskIndicator />
          <button className="icon-btn" title="Keyboard shortcuts" onClick={() => useApp.setState({ shortcutsOpen: true })}>
            <Icon name="keyboard" size={16} />
          </button>
          <button className="icon-btn" title="System info" onClick={() => useApp.setState({ aboutOpen: true })}>
            <Icon name="info" size={16} />
          </button>
        </div>
      </div>
      <div className="module-host">
        <Suspense
          fallback={
            <div className="empty-state">
              <Spinner />
            </div>
          }
        >
          {module === 'library' && <LibraryModule />}
          {module === 'develop' && <DevelopModule />}
          {module === 'editor' && <EditorModule />}
          {module === 'video' && <VideoModule />}
        </Suspense>
      </div>
      <OverlayHost />
      {shortcutsOpen && <ShortcutsDialog onClose={() => useApp.setState({ shortcutsOpen: false })} />}
      {aboutOpen && <AboutDialog onClose={() => useApp.setState({ aboutOpen: false })} />}
    </div>
  );
}

const SHORTCUTS: { section: string; items: [string, string][] }[] = [
  {
    section: 'Global',
    items: [
      ['mod+alt+1 … 4', 'Library / Develop / Edit / Video'],
      ['mod+z / shift+mod+z', 'Undo / Redo'],
      ['mod+s', 'Save'],
      ['shift+mod+e', 'Export'],
      ['mod+/', 'This list'],
    ],
  },
  {
    section: 'Library',
    items: [
      ['g / e / n', 'Grid / Loupe / Survey'],
      ['enter / escape', 'Loupe / back to Grid'],
      ['d', 'Open in Develop'],
      ['z or space', 'Loupe 100%'],
      ['i', 'Cycle loupe info'],
      ['0 – 5', 'Star rating'],
      ['p / x / u', 'Pick / Reject / Unflag'],
      ['6 – 9', 'Color labels'],
      ['arrows (+shift)', 'Navigate / extend'],
      ["mod+'", 'Virtual copy'],
      ['mod+[ / mod+]', 'Rotate'],
      ['mod+e', 'Edit in Editor'],
      ['delete', 'Remove from catalog / collection'],
      ['tab · f6 f7 f8 · \\', 'Panels · filmstrip · filter bar'],
      ['- / =', 'Thumbnail size'],
    ],
  },
  {
    section: 'Develop',
    items: [
      ['\\', 'Before / after'],
      ['y', 'Compare: split → side by side → off'],
      ['j', 'Clipping warnings'],
      ['z', 'Zoom fit ↔ 100%'],
      ['r', 'Crop & straighten (x swaps, enter applies)'],
      ['w', 'White balance picker'],
      ['shift+m', 'Masking'],
      ['m / shift+r / k', 'Linear / radial / brush mask'],
      ['o', 'Mask overlay'],
      ['shift+a', 'Auto tone'],
      ['shift+mod+c / shift+mod+v', 'Copy / paste settings'],
      ['shift+mod+r', 'Reset settings'],
      ['left / right', 'Previous / next photo'],
      ['mod+e', 'Edit in Editor'],
      ['tab', 'Hide / show panels'],
    ],
  },
  {
    section: 'Edit',
    items: [
      ['v m l w c i j b s e g r o t u h z', 'Tools (shift+key cycles variants)'],
      ['[ / ]  ·  shift+[ / ]', 'Brush size · hardness'],
      ['1 … 0', 'Tool / layer opacity 10 … 100%'],
      ['x / d', 'Swap / reset colors'],
      ['mod+j / shift+mod+j', 'Layer via copy / cut'],
      ['shift+mod+n', 'New layer'],
      ['mod+t', 'Free transform'],
      ['mod+e', 'Merge down'],
      ['mod+i / shift+mod+i', 'Invert / Select inverse'],
      ['mod+l · mod+m · mod+u · mod+b', 'Levels · Curves · Hue/Sat · Color Balance'],
      ['alt+backspace / mod+backspace', 'Fill foreground / background'],
      ['alt+mod+f / shift+mod+a', 'Last filter / Camera Raw filter'],
      ['space (hold)', 'Pan'],
    ],
  },
  {
    section: 'Video',
    items: [
      ['space / k', 'Play / pause'],
      ['j / l', 'Shuttle reverse / forward (repeat: 2× 4× 8×)'],
      ['left / right (shift = 5)', 'Step frame'],
      ['up / down', 'Previous / next edit point'],
      ['i / o / alt+x', 'Mark in / out / clear'],
      [', / .', 'Insert / overwrite from Source'],
      ['v / b / c', 'Selection / ripple edit / razor'],
      ['s', 'Toggle snapping'],
      ['mod+k', 'Split at playhead'],
      ['delete / shift+delete', 'Clear / ripple delete'],
      ['alt+left / alt+right', 'Nudge clips'],
      ['shift+e', 'Enable / disable clip'],
      ['shift+d', 'Default transition on selection'],
      ['alt+r', 'Speed / Duration'],
      ["; / '", 'Lift / extract In→Out'],
      ['- / = / \\', 'Zoom timeline out / in / fit'],
      ['m', 'Add marker'],
    ],
  },
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard Shortcuts" onClose={onClose} width={760}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        {SHORTCUTS.map((s) => (
          <div key={s.section}>
            <div className="panel-sub">{s.section}</div>
            {s.items.map(([k, d]) => (
              <div key={k} className="row" style={{ justifyContent: 'space-between', padding: '3px 0' }}>
                <span className="muted">{d}</span>
                <Kbd>{k.replace(/mod/g, isMac ? '⌘' : 'Ctrl')}</Kbd>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  const [info] = useState(gpuInfo);
  return (
    <Modal title="LightPhoto Studio" onClose={onClose} width={520}>
      <div className="muted">Photo library, RAW developer, layered editor and video editor — GPU accelerated.</div>
      <div className="sep-h" />
      {Object.entries(info).map(([k, v]) => (
        <div key={k} className="field">
          <label>{k}</label>
          <span className="mono ellipsis" title={String(v)}>
            {String(v)}
          </span>
        </div>
      ))}
    </Modal>
  );
}
