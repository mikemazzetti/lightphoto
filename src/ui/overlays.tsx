import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { closeDialog, closeMenu, MenuItem, openDialog, openMenu, useApp } from '@/state/app';
import { Button, cx, Progress } from './controls';
import { Icon } from './Icon';

/** Positions a fixed element near (x, y), flipping to stay on screen (to end at `flipX` when given). */
function useFit(ref: React.RefObject<HTMLElement | null>, x: number, y: number, flipX?: number) {
  const [pos, setPos] = useState({ left: x, top: y, visible: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = x + r.width > window.innerWidth - 6 ? Math.max(6, (flipX ?? x) - r.width) : x;
    const top = y + r.height > window.innerHeight - 6 ? Math.max(6, window.innerHeight - r.height - 6) : y;
    setPos({ left, top, visible: true });
  }, [x, y, flipX, ref]);
  return pos;
}

/** A floating panel anchored at a point; closes on outside click / Escape. */
export function Popover({ x, y, onClose, children, className, style }: { x: number; y: number; onClose: () => void; children: ReactNode; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useFit(ref, x, y);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const t = setTimeout(() => window.addEventListener('pointerdown', down, true), 0);
    window.addEventListener('keydown', key, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className={cx('popover', className)} style={{ left: pos.left, top: pos.top, visibility: pos.visible ? 'visible' : 'hidden', ...style }} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>,
    document.body,
  );
}

/**
 * Submenu panel. Rendered inside the parent popover's DOM (position: fixed escapes its overflow),
 * so clicks in it count as "inside" for the root popover's outside-click handling.
 */
function Submenu({ x, y, flipX, items, onDone }: { x: number; y: number; flipX: number; items: MenuItem[]; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useFit(ref, x, y, flipX);
  return (
    <div ref={ref} className="popover" style={{ left: pos.left, top: pos.top, visibility: pos.visible ? 'visible' : 'hidden' }}>
      <MenuList items={items} onDone={onDone} />
    </div>
  );
}

function MenuList({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flipX: number } | null>(null);
  return (
    <>
      {items.map((it, i) => {
        if (it.separator) return <div key={i} className="menu-sep" />;
        if (it.heading) return <div key={i} className="menu-label">{it.heading}</div>;
        return (
          <div
            key={i}
            className={cx('menu-item', it.disabled && 'disabled')}
            style={it.danger ? { color: '#ff8c8f' } : undefined}
            onMouseEnter={(e) => {
              if (it.submenu) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setSub({ index: i, x: r.right + 2, y: r.top - 4, flipX: r.left - 2 });
              } else setSub(null);
            }}
            onClick={() => {
              if (it.submenu) return;
              onDone();
              it.onClick?.();
            }}
          >
            <span className="check">{it.checked ? <Icon name="check" size={13} /> : it.icon}</span>
            <span>{it.label}</span>
            {it.shortcut && <span className="shortcut">{it.shortcut}</span>}
            {it.submenu && <Icon name="chevronRight" size={12} style={{ marginLeft: 'auto' }} />}
          </div>
        );
      })}
      {sub && items[sub.index]?.submenu && <Submenu key={sub.index} x={sub.x} y={sub.y} flipX={sub.flipX} items={items[sub.index].submenu!} onDone={onDone} />}
    </>
  );
}

/** Dropdown menu button. */
export function MenuButton({ items, children, className, title }: { items: MenuItem[] | (() => MenuItem[]); children: ReactNode; className?: string; title?: string }) {
  return (
    <button
      type="button"
      className={className ?? 'btn'}
      title={title}
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom + 4, typeof items === 'function' ? items() : items);
      }}
    >
      {children}
    </button>
  );
}

export function Modal({
  title,
  children,
  footer,
  onClose,
  width,
}: {
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width } : undefined} onKeyDown={(e) => e.stopPropagation()}>
        {title && <div className="modal-header">{title}</div>}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Promise-based confirm dialog. */
export function confirmDialog(message: ReactNode, opts: { title?: string; ok?: string; cancel?: string; danger?: boolean } = {}): Promise<boolean> {
  return openDialog<boolean>((close) => (
    <Modal
      title={opts.title ?? 'Confirm'}
      onClose={() => close(false)}
      footer={
        <>
          <Button onClick={() => close(false)}>{opts.cancel ?? 'Cancel'}</Button>
          <Button variant={opts.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
            {opts.ok ?? 'OK'}
          </Button>
        </>
      }
    >
      <div style={{ maxWidth: 420 }}>{message}</div>
    </Modal>
  )).then((v) => !!v);
}

/** Promise-based text prompt. Resolves null when cancelled. */
export function promptDialog(title: string, initial = '', opts: { label?: string; ok?: string } = {}): Promise<string | null> {
  return openDialog<string | null>((close) => <PromptBody title={title} initial={initial} label={opts.label} ok={opts.ok} close={close} />).then((v) => (v === undefined ? null : v));
}

function PromptBody({ title, initial, label, ok, close }: { title: string; initial: string; label?: string; ok?: string; close: (v?: string | null) => void }) {
  const [v, setV] = useState(initial);
  return (
    <Modal
      title={title}
      onClose={() => close(null)}
      footer={
        <>
          <Button onClick={() => close(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => close(v)}>
            {ok ?? 'OK'}
          </Button>
        </>
      }
    >
      {label && <div className="muted">{label}</div>}
      <input
        className="input"
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') close(v);
        }}
        style={{ width: 320 }}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Global hosts (mounted once in App)

export function OverlayHost() {
  const menu = useApp((s) => s.menu);
  const dialogs = useApp((s) => s.dialogs);
  const toasts = useApp((s) => s.toasts);
  return (
    <>
      {menu && (
        <Popover x={menu.x} y={menu.y} onClose={closeMenu}>
          <MenuList items={menu.items} onDone={closeMenu} />
        </Popover>
      )}
      {dialogs.map((d) => (
        <DialogSlot key={d.id} id={d.id} render={d.render} />
      ))}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={cx('toast', t.kind)}>
            {t.message}
          </div>
        ))}
      </div>
    </>
  );
}

function DialogSlot({ id, render }: { id: number; render: (close: (v?: unknown) => void) => ReactNode }) {
  return <>{render((v) => closeDialog(id, v))}</>;
}

export function TaskIndicator() {
  const tasks = useApp((s) => s.tasks);
  if (!tasks.length) return null;
  const t = tasks[tasks.length - 1];
  return (
    <div className="task-pill no-drag" title={tasks.map((x) => x.label).join('\n')}>
      <span className="ellipsis">
        {t.label}
        {tasks.length > 1 ? ` (+${tasks.length - 1})` : ''}
      </span>
      <Progress value={t.progress} />
      {t.cancel && (
        <button className="icon-btn small" title="Cancel" onClick={t.cancel}>
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}
