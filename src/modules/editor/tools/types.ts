import type { Doc } from '../model/doc';
import type { ViewState } from '../model/types';

export interface ToolPointer {
  /** Image coordinates (fractional). */
  x: number;
  y: number;
  /** CSS pixels relative to the canvas container. */
  sx: number;
  sy: number;
  pressure: number;
  shift: boolean;
  alt: boolean;
  mod: boolean;
  button: number;
  /** Coalesced samples since the previous event (image coordinates), including this one. */
  points: { x: number; y: number; p: number }[];
  pointerType: string;
  /** Time-stamp of the original event (ms). */
  t: number;
}

export interface ToolEnv {
  doc: Doc;
  view: ViewState;
  dpr: number;
  /** Size of the viewport (CSS px). */
  width: number;
  height: number;
  toScreen(x: number, y: number): [number, number];
  toImage(sx: number, sy: number): [number, number];
  /** Zoom to a scale (CSS px per image px) keeping the screen point fixed. */
  zoomAt(scale: number, sx: number, sy: number): void;
  zoomStep(dir: 1 | -1, sx: number, sy: number): void;
  panBy(dx: number, dy: number): void;
  fit(): void;
}

export interface Tool {
  /** CSS cursor while hovering. */
  cursor(env: ToolEnv, p: ToolPointer | null): string;
  /** When set, a circle of this diameter (image px) is drawn as the cursor. */
  brushSize?(env: ToolEnv): number | null;
  down?(env: ToolEnv, p: ToolPointer): void;
  move?(env: ToolEnv, p: ToolPointer): void;
  up?(env: ToolEnv, p: ToolPointer): void;
  hover?(env: ToolEnv, p: ToolPointer): void;
  dblclick?(env: ToolEnv, p: ToolPointer): void;
  /** Keyboard while this tool is active (Enter / Escape / Backspace…). Return true when handled. */
  key?(env: ToolEnv, e: KeyboardEvent): boolean;
  /** Draws tool UI on the 2D overlay (CSS pixel space). */
  overlay?(env: ToolEnv, ctx: CanvasRenderingContext2D): void;
  /** Called when switching away (commit or cancel pending work). */
  deactivate?(env: ToolEnv | null): void;
  /** True while the tool has uncommitted interactive state (e.g. crop box, polygon in progress). */
  busy?(): boolean;
}

/** Helpers for overlays: crisp 1px lines with a dark halo. */
export function strokeHalo(ctx: CanvasRenderingContext2D, path: () => void, color = '#fff', dash?: number[]) {
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.setLineDash([]);
  path();
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  if (dash) ctx.setLineDash(dash);
  path();
  ctx.stroke();
  ctx.restore();
}

export function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number, size = 7) {
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#1473e6';
  ctx.lineWidth = 1;
  ctx.fillRect(Math.round(x - size / 2) + 0.5, Math.round(y - size / 2) + 0.5, size, size);
  ctx.strokeRect(Math.round(x - size / 2) + 0.5, Math.round(y - size / 2) + 0.5, size, size);
  ctx.restore();
}

export const ACCENT = '#1473e6';
