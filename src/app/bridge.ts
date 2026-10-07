import { create } from 'zustand';
import { useApp } from '@/state/app';

/**
 * Cross-module hand-offs ("Edit in Photoshop", "Send to video"). Items wait in an inbox until the
 * target module mounts and consumes them with `takeEditorInbox()` / `takeVideoInbox()`.
 */

export interface EditorInboxItem {
  name: string;
  image: ImageBitmap | ImageData | HTMLCanvasElement | OffscreenCanvas;
  /** Optional source path (for "Save" defaults). */
  path?: string;
  /** Called with the edited result when the user chooses "Save back" (e.g. to return to Library). */
  onSaveBack?: (canvas: HTMLCanvasElement | OffscreenCanvas) => void;
}

export interface VideoInboxItem {
  path: string;
}

interface BridgeState {
  editor: EditorInboxItem[];
  video: VideoInboxItem[];
}

export const useBridge = create<BridgeState>(() => ({ editor: [], video: [] }));

export function openInEditor(item: EditorInboxItem) {
  useBridge.setState((s) => ({ editor: [...s.editor, item] }));
  useApp.getState().setModule('editor');
}

export function sendToVideo(paths: string[]) {
  useBridge.setState((s) => ({ video: [...s.video, ...paths.map((path) => ({ path }))] }));
  useApp.getState().setModule('video');
}

export function takeEditorInbox(): EditorInboxItem[] {
  const items = useBridge.getState().editor;
  if (items.length) useBridge.setState({ editor: [] });
  return items;
}

export function takeVideoInbox(): VideoInboxItem[] {
  const items = useBridge.getState().video;
  if (items.length) useBridge.setState({ video: [] });
  return items;
}
