import { create } from 'zustand';
import type { ReactNode } from 'react';

export type ModuleId = 'library' | 'develop' | 'editor' | 'video';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error' | 'warn';
}

export interface Task {
  id: number;
  label: string;
  progress: number | null; // 0..1 or null = indeterminate
  cancel?: () => void;
}

export interface MenuItem {
  label?: string;
  shortcut?: string;
  icon?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
  separator?: boolean;
  heading?: string;
  submenu?: MenuItem[];
}

export interface DialogSpec {
  id: number;
  render: (close: (value?: unknown) => void) => ReactNode;
  resolve: (value: unknown) => void;
}

interface AppState {
  module: ModuleId;
  setModule: (m: ModuleId) => void;
  toasts: Toast[];
  tasks: Task[];
  menu: { x: number; y: number; items: MenuItem[] } | null;
  dialogs: DialogSpec[];
  shortcutsOpen: boolean;
  aboutOpen: boolean;
}

export const useApp = create<AppState>((set) => ({
  module: 'library',
  setModule: (module) => set({ module }),
  toasts: [],
  tasks: [],
  menu: null,
  dialogs: [],
  shortcutsOpen: false,
  aboutOpen: false,
}));

let seq = 1;

export function toast(message: string, kind: Toast['kind'] = 'info', ms = kind === 'error' ? 6000 : 3200) {
  const id = seq++;
  useApp.setState((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
  setTimeout(() => useApp.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

export function errorToast(e: unknown, prefix = '') {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(e);
  toast(prefix ? `${prefix}: ${msg}` : msg, 'error');
}

/** Shows a progress item in the title bar. Call `done()` when finished. */
export function startTask(label: string, cancel?: () => void) {
  const id = seq++;
  useApp.setState((s) => ({ tasks: [...s.tasks, { id, label, progress: null, cancel }] }));
  return {
    update(progress: number | null, newLabel?: string) {
      useApp.setState((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, progress, label: newLabel ?? t.label } : t)) }));
    },
    done() {
      useApp.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
    },
  };
}

export function openMenu(x: number, y: number, items: MenuItem[]) {
  useApp.setState({ menu: { x, y, items } });
}
export function openContextMenu(e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) {
  e.preventDefault();
  openMenu(e.clientX, e.clientY, items);
}
export const closeMenu = () => useApp.setState({ menu: null });

/** Opens a dialog rendered by the global host. Resolves with the value passed to close(). */
export function openDialog<T = unknown>(render: (close: (value?: T) => void) => ReactNode): Promise<T | undefined> {
  return new Promise((resolve) => {
    const id = seq++;
    const spec: DialogSpec = { id, render: render as DialogSpec['render'], resolve: resolve as (v: unknown) => void };
    useApp.setState((s) => ({ dialogs: [...s.dialogs, spec] }));
  });
}
export function closeDialog(id: number, value?: unknown) {
  const d = useApp.getState().dialogs.find((x) => x.id === id);
  useApp.setState((s) => ({ dialogs: s.dialogs.filter((x) => x.id !== id) }));
  d?.resolve(value);
}
