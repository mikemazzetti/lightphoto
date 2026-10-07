import type { FxType, TransitionType } from '../model/types';

/** In-app drag payloads (HTML5 DnD can't read data during dragover, so we keep it here). */
export type DragPayload =
  | { kind: 'media'; ids: string[]; inSec?: number; outSec?: number }
  | { kind: 'transition'; type: TransitionType }
  | { kind: 'effect'; type: FxType | 'lumetri' };

let payload: DragPayload | null = null;

export function setDragPayload(p: DragPayload | null) {
  payload = p;
}
export const getDragPayload = () => payload;

export const DND_MIME = 'application/x-lp-video';
