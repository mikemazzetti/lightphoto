import { useEffect, useRef } from 'react';
import { api } from '@/platform/api';

/**
 * Commands & keyboard shortcuts.
 *
 * - Native menu items send a command id (e.g. 'edit:undo', 'file:save') — see electron/main.ts.
 * - Modules register handlers with `useCommands({ 'edit:undo': () => … })` while mounted.
 *   The most recently registered scope wins; a handler returning `false` passes through.
 * - `useKeymap({ 'mod+z': 'edit:undo', 'b': () => setTool('brush') })` binds keys (to command ids
 *   or functions). Keys are ignored while typing in inputs, except combos with mod.
 *
 * Combo syntax: modifiers in any order joined by '+': mod (⌘ on mac, Ctrl elsewhere), ctrl, alt,
 * shift, then the key: a-z 0-9 [ ] - = , . / \ ; ' ` space enter escape tab backspace delete
 * arrowleft arrowright arrowup arrowdown home end pageup pagedown f1-f12.
 */

type Handler = (payload?: unknown) => void | boolean | Promise<unknown>;
type Binding = string | ((e: KeyboardEvent) => void | boolean);

const commandScopes: { id: number; map: Record<string, Handler> }[] = [];
const keyScopes: { id: number; map: Map<string, Binding> }[] = [];
let scopeSeq = 0;

export const isMac = api.platform === 'darwin';

export function runCommand(id: string, payload?: unknown): boolean {
  for (let i = commandScopes.length - 1; i >= 0; i--) {
    const h = commandScopes[i].map[id];
    if (h) {
      const r = h(payload);
      if (r !== false) return true;
    }
  }
  return false;
}

export function useCommands(map: Record<string, Handler>, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const id = ++scopeSeq;
    // Proxy so handlers always see the latest closure without re-registering.
    const proxy: Record<string, Handler> = {};
    for (const k of Object.keys(ref.current)) proxy[k] = (p) => ref.current[k]?.(p);
    commandScopes.push({ id, map: proxy });
    return () => {
      const i = commandScopes.findIndex((s) => s.id === id);
      if (i >= 0) commandScopes.splice(i, 1);
    };
    // Re-register only when the set of command names changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, Object.keys(map).sort().join('|')]);
}

function normalizeCombo(combo: string): string {
  const lower = combo.toLowerCase();
  const parts = lower.endsWith('++') ? [...lower.slice(0, -2).split('+').filter(Boolean), '+'] : lower.split('+');
  const key = parts.pop()!;
  const mods = new Set(parts.map((m) => (m === 'mod' ? (isMac ? 'meta' : 'ctrl') : m === 'cmd' ? 'meta' : m)));
  return [...['meta', 'ctrl', 'alt', 'shift'].filter((m) => mods.has(m)), key].join('+');
}

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Space: 'space',
};

export function eventKey(e: KeyboardEvent): string {
  let key: string;
  if (e.code.startsWith('Key')) key = e.code.slice(3).toLowerCase();
  else if (e.code.startsWith('Digit')) key = e.code.slice(5);
  else if (e.code.startsWith('Numpad') && /\d$/.test(e.code)) key = e.code.slice(-1);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (key === 'del') key = 'delete';
  const mods: string[] = [];
  if (e.metaKey) mods.push('meta');
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  return [...mods, key].join('+');
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    const t = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'range', 'button', 'color'].includes(t);
  }
  return el.tagName === 'SELECT';
}

export function useKeymap(map: Record<string, Binding>, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const id = ++scopeSeq;
    // combo → binding resolved through ref at call time, so handlers always see fresh closures.
    const m = new Map<string, Binding>();
    for (const orig of Object.keys(ref.current)) {
      const b = ref.current[orig];
      m.set(normalizeCombo(orig), typeof b === 'string' ? b : (e: KeyboardEvent) => (ref.current[orig] as (e: KeyboardEvent) => void | boolean)(e));
    }
    keyScopes.push({ id, map: m });
    return () => {
      const i = keyScopes.findIndex((s) => s.id === id);
      if (i >= 0) keyScopes.splice(i, 1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, Object.keys(map).sort().join('|')]);
}

/** Global keydown dispatcher; installed once by the App. */
export function handleKeyDown(e: KeyboardEvent) {
  const combo = eventKey(e);
  // Arrow keys belong to a focused range input / select, not to tool shortcuts.
  const el = e.target as HTMLInputElement | null;
  if (/^arrow/.test(e.key.toLowerCase()) && el && ((el.tagName === 'INPUT' && el.type === 'range') || el.tagName === 'SELECT')) return;
  const typing = isTyping(e.target);
  const hasMod = e.metaKey || e.ctrlKey;
  if (typing && !hasMod && combo !== 'escape') return;
  // Leave text editing shortcuts to the field.
  if (typing && hasMod && /^(meta|ctrl)\+(shift\+)?(z|a|c|v|x|y)$/.test(combo)) return;
  for (let i = keyScopes.length - 1; i >= 0; i--) {
    const b = keyScopes[i].map.get(combo);
    if (b === undefined) continue;
    const handled = typeof b === 'string' ? runCommand(b) : b(e) !== false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }
}

/** Menu actions arriving from the native menu (or anywhere else). */
export function handleMenuAction(action: string, payload?: unknown) {
  const el = document.activeElement;
  if (isTyping(el)) {
    if (action === 'edit:undo') return void document.execCommand('undo');
    if (action === 'edit:redo') return void document.execCommand('redo');
    if (action === 'edit:selectAll') return void document.execCommand('selectAll');
  }
  runCommand(action, payload);
}

/** Tracks whether a key (e.g. 'space') is currently held — for spring-loaded tools. */
export function useKeyHeld(key: string, onChange: (held: boolean) => void, enabled = true) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!enabled) return;
    let held = false;
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (eventKey(e).split('+').pop() === key && !held) {
        held = true;
        cb.current(true);
        if (key === 'space') e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (eventKey(e).split('+').pop() === key && held) {
        held = false;
        cb.current(false);
      }
    };
    const blur = () => {
      if (held) {
        held = false;
        cb.current(false);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [key, enabled]);
}

/** Human-readable shortcut label for menus/tooltips. */
export function shortcutLabel(combo: string): string {
  const parts = combo.split('+');
  const key = parts.pop()!;
  const sym: Record<string, string> = isMac
    ? { mod: '⌘', cmd: '⌘', meta: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }
    : { mod: 'Ctrl+', cmd: 'Ctrl+', meta: 'Win+', ctrl: 'Ctrl+', alt: 'Alt+', shift: 'Shift+' };
  const k = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
  return parts.map((p) => sym[p] ?? p).join('') + k;
}
