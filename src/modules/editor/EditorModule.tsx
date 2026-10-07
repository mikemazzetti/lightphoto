import { useEffect } from 'react';
import { isTyping, useCommands, useKeymap } from '@/app/commands';
import { takeEditorInbox, useBridge } from '@/app/bridge';
import { api } from '@/platform/api';
import { errorToast } from '@/state/app';
import { activeDoc, edState, loadPrefs, syncDirty, touch, useEditor } from './model/store';
import { A, adjustBrush, arrowKey, numberKey, settleSessions, toolKey } from './actions';
import { TOOL_GROUPS } from './model/store';
import { copyPixels } from './ops/edit';
import { handlePasteEvent } from './io/clipboard';
import { openFromInbox } from './io/files';
import { textEditing } from './tools/text';
import { transformActive } from './tools/transform';
import { CanvasView } from './ui/CanvasView';
import { DocTabs, EmptyState, MenuBar, PanelDock, StatusBar } from './ui/Chrome';
import { OptionsBar } from './ui/OptionsBar';
import { Toolbox } from './ui/Toolbox';
import './editor.css';

/** Keys the native (Electron) menu already owns — bound here only in the browser build. */
const NATIVE_KEYS: Record<string, () => void> = {
  'mod+n': A.newDoc,
  'mod+o': A.open,
  'mod+s': A.save,
  'shift+mod+s': A.saveAs,
  'shift+mod+e': A.exportAs,
  'mod+z': A.undo,
  'shift+mod+z': A.redo,
  'mod+y': A.redo,
  'mod+a': A.selectAll,
  'mod+d': A.deselect,
  'mod+=': A.zoomIn,
  'mod+-': A.zoomOut,
  'mod+0': A.fit,
  'mod+1': A.actual,
};

function usePasteAndCopy() {
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (isTyping(e.target) || isTyping(document.activeElement)) return;
      const d = activeDoc();
      if (!d || useEditor.getState().modal) return;
      e.preventDefault();
      settleSessions();
      void copyPixels(d, false, e.type === 'cut');
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target) || isTyping(document.activeElement)) return;
      if (useEditor.getState().modal) return;
      e.preventDefault();
      settleSessions();
      void handlePasteEvent(e);
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste);
    };
  }, []);
}

function useInbox() {
  const inbox = useBridge((s) => s.editor);
  useEffect(() => {
    const items = takeEditorInbox();
    for (const it of items) {
      try {
        openFromInbox(it);
      } catch (e) {
        errorToast(e, `Could not open ${it.name}`);
      }
    }
  }, [inbox]);
}

function useEditorKeys() {
  const guard = (fn: () => unknown) => () => {
    if (!activeDoc() && fn !== A.newDoc && fn !== A.open) return false;
    if (useEditor.getState().modal || textEditing()) return false;
    fn();
  };
  const keys: Record<string, string | ((e: KeyboardEvent) => void | boolean)> = {};
  for (const g of TOOL_GROUPS) {
    keys[g.key] = () => {
      if (useEditor.getState().modal || textEditing()) return false;
      toolKey(g.key, false);
    };
    keys[`shift+${g.key}`] = () => {
      if (useEditor.getState().modal || textEditing()) return false;
      toolKey(g.key, true);
    };
  }
  Object.assign(keys, {
    '[': () => adjustBrush('size', -1),
    ']': () => adjustBrush('size', 1),
    'shift+[': () => adjustBrush('hardness', -1),
    'shift+]': () => adjustBrush('hardness', 1),
    x: guard(A.swapColors),
    d: guard(A.resetColors),
    'mod+j': guard(A.layerViaCopy),
    'shift+mod+j': guard(A.layerViaCut),
    'shift+mod+n': guard(A.newLayer),
    'mod+t': guard(A.freeTransform),
    'mod+i': guard(A.invert),
    'shift+mod+i': guard(A.inverse),
    'mod+e': guard(A.mergeDown),
    'shift+alt+mod+e': guard(A.mergeVisible),
    'alt+mod+g': guard(A.clip),
    'mod+l': guard(() => A.adjust('levels')),
    'mod+m': guard(() => A.adjust('curves')),
    'mod+u': guard(() => A.adjust('hueSat')),
    'mod+b': guard(() => A.adjust('colorBalance')),
    'alt+shift+mod+b': guard(() => A.adjust('bw')),
    'shift+mod+u': guard(A.desaturate),
    'shift+mod+l': guard(() => A.auto('tone')),
    'alt+shift+mod+l': guard(() => A.auto('contrast')),
    'shift+mod+b': guard(() => A.auto('color')),
    'alt+mod+i': guard(A.imageSize),
    'alt+mod+c': guard(A.canvasSize),
    'shift+mod+d': guard(A.reselect),
    'shift+f6': guard(() => A.modify('feather')),
    'shift+f5': guard(A.fill),
    'shift+backspace': guard(A.fill),
    'alt+mod+f': guard(A.lastFilter),
    'shift+mod+a': guard(A.cameraRaw),
    'alt+mod+z': guard(A.stepBackward),
    'shift+alt+mod+z': guard(A.stepForward),
    'shift+mod+c': guard(A.copyMerged),
    'shift+mod+v': guard(A.pasteInPlace),
    "mod+'": () => A.toggleGrid(),
    'mod+]': guard(() => A.arrange('forward')),
    'mod+[': guard(() => A.arrange('backward')),
    'shift+mod+]': guard(() => A.arrange('front')),
    'shift+mod+[': guard(() => A.arrange('back')),
    backspace: guard(A.clear),
    delete: guard(A.clear),
    'alt+backspace': guard(A.fillFg),
    'alt+delete': guard(A.fillFg),
    'mod+backspace': guard(A.fillBg),
    'mod+delete': guard(A.fillBg),
    arrowleft: () => arrowKey(-1, 0),
    arrowright: () => arrowKey(1, 0),
    arrowup: () => arrowKey(0, -1),
    arrowdown: () => arrowKey(0, 1),
    'shift+arrowleft': () => arrowKey(-10, 0),
    'shift+arrowright': () => arrowKey(10, 0),
    'shift+arrowup': () => arrowKey(0, -10),
    'shift+arrowdown': () => arrowKey(0, 10),
  });
  for (let n = 0; n <= 9; n++) keys[String(n)] = () => (useEditor.getState().modal || textEditing() ? false : numberKey(n));
  if (!api.isElectron) for (const [k, fn] of Object.entries(NATIVE_KEYS)) keys[k] = guard(fn);
  useKeymap(keys);

  useCommands({
    'file:new': () => A.newDoc(),
    'file:open': () => A.open(),
    'file:save': () => A.save(),
    'file:saveAs': () => A.saveAs(),
    'file:export': () => A.exportAs(),
    'edit:undo': () => A.undo(),
    'edit:redo': () => A.redo(),
    'edit:selectAll': () => A.selectAll(),
    'edit:deselect': () => A.deselect(),
    'view:zoomIn': () => A.zoomIn(),
    'view:zoomOut': () => A.zoomOut(),
    'view:fit': () => A.fit(),
    'view:actual': () => A.actual(),
    // ⇧⌘I is "Import Photos" in the shared menu; inside Edit it means Select ▸ Inverse (Photoshop).
    'library:importFiles': () => {
      if (activeDoc()) A.inverse();
      else A.open();
    },
  });
}

export default function EditorModule() {
  const hasDocs = useEditor((s) => s.docs.length > 0);
  useEffect(() => {
    void loadPrefs();
    syncDirty();
    return () => {
      settleSessions();
    };
  }, []);
  useInbox();
  usePasteAndCopy();
  useEditorKeys();

  // Keep panels in sync with transform / text sessions.
  useEffect(() => {
    const t = setInterval(() => {
      if (!transformActive() && edState().session === 'transform') useEditor.setState({ session: null });
    }, 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="ed-root">
      <MenuBar />
      <OptionsBar />
      <div className="ed-main">
        <Toolbox />
        <div className="ed-center">
          <DocTabs />
          <div className="ed-canvas-wrap">
            <CanvasView />
            {!hasDocs && <EmptyState />}
          </div>
          <StatusBar />
        </div>
        <PanelDock />
      </div>
    </div>
  );
}
