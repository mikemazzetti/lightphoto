import { ReactNode, useEffect, useRef, useState } from 'react';
import { closeMenu, openMenu, useApp } from '@/state/app';
import { Button, cx } from '@/ui/controls';
import { Icon } from '@/ui/Icon';
import { zoomPercent } from '@/ui/viewport';
import { basename } from '@/platform/api';
import { bus } from '../model/bus';
import { useActiveDoc, useEditor } from '../model/store';
import { activateDoc, closeDoc } from '../ops/docs';
import { A, settleSessions } from '../actions';
import { openPath, recentFiles } from '../io/files';
import { MENUS } from './menus';
import { LayersPanel } from './panels/LayersPanel';
import { PropertiesPanel } from './panels/PropertiesPanel';
import { ColorPanel, HistoryPanel, NavigatorPanel, SwatchesPanel } from './panels/MiscPanels';

// ---------------------------------------------------------------------------------------------
// Menu strip

export function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  const menu = useApp((s) => s.menu);
  const current = menu ? open : null;
  const show = (i: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setOpen(i);
    openMenu(r.left, r.bottom + 1, MENUS[i].items());
  };
  return (
    <div className="ed-menubar">
      {MENUS.map((m, i) => (
        <button
          key={m.label}
          type="button"
          className={cx('ed-menu-btn', current === i && 'open')}
          onPointerDown={(e) => {
            e.preventDefault();
            if (current === i) {
              closeMenu();
              return;
            }
            show(i, e.currentTarget);
          }}
          onMouseEnter={(e) => {
            if (current !== null && current !== i) show(i, e.currentTarget);
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Document tabs

export function DocTabs() {
  const docs = useEditor((s) => s.docs);
  const activeId = useEditor((s) => s.activeId);
  useEditor((s) => s.rev);
  const [, force] = useState(0);
  useEffect(() => {
    let raf = 0;
    const off = bus.view.on(() => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          force((x) => x + 1);
        });
    });
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, []);
  if (!docs.length) return null;
  return (
    <div className="ed-tabs">
      {docs.map((d) => (
        <div
          key={d.id}
          className={cx('ed-tab', d.id === activeId && 'active')}
          title={d.path ?? d.name}
          onClick={() => {
            if (d.id === activeId || useEditor.getState().modal) return;
            settleSessions();
            activateDoc(d.id);
          }}
          onAuxClick={(e) => {
            if (e.button !== 1 || useEditor.getState().modal) return;
            settleSessions();
            void closeDoc(d.id);
          }}
        >
          <span className="ellipsis">
            {d.name} @ {Math.round(zoomPercent(d.view))}%
          </span>
          {d.dirty && <span className="ed-dirty">●</span>}
          <button
            type="button"
            className="ed-tab-close"
            title="Close"
            onClick={(e) => {
              e.stopPropagation();
              if (useEditor.getState().modal) return;
              settleSessions();
              void closeDoc(d.id);
            }}
          >
            <Icon name="x" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Status bar (updated straight from the event bus, no React re-render per mouse move)

export function StatusBar() {
  const doc = useActiveDoc();
  const zoomRef = useRef<HTMLSpanElement>(null);
  const posRef = useRef<HTMLSpanElement>(null);
  const colRef = useRef<HTMLSpanElement>(null);
  const swRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const upd = () => {
      if (zoomRef.current && doc) zoomRef.current.textContent = `${zoomPercent(doc.view).toFixed(zoomPercent(doc.view) < 10 ? 1 : 0)}%`;
    };
    upd();
    const off1 = bus.view.on(upd);
    const off2 = bus.cursor.on((c) => {
      if (!posRef.current || !colRef.current || !swRef.current) return;
      if (!c) {
        posRef.current.textContent = '';
        colRef.current.textContent = '';
        swRef.current.style.background = 'transparent';
        return;
      }
      posRef.current.textContent = `X ${Math.floor(c.x)}  Y ${Math.floor(c.y)}`;
      if (c.rgba) {
        const [r, g, b, a] = c.rgba.map(Math.round);
        colRef.current.textContent = `R ${r}  G ${g}  B ${b}${a < 255 ? `  A ${Math.round((a / 255) * 100)}%` : ''}`;
        swRef.current.style.background = `rgba(${r},${g},${b},${a / 255})`;
      } else {
        colRef.current.textContent = '';
        swRef.current.style.background = 'transparent';
      }
    });
    return () => {
      off1();
      off2();
    };
  }, [doc]);
  if (!doc) return <div className="ed-status" />;
  const mb = (b: number) => `${(b / 1048576).toFixed(b > 104857600 ? 0 : 1)}M`;
  return (
    <div className="ed-status">
      <span ref={zoomRef} className="ed-status-zoom" />
      <span className="sep-v" />
      <span>
        {doc.width} × {doc.height} px
      </span>
      <span className="sep-v" />
      <span title="Layer memory / history memory">
        Doc: {mb(doc.width * doc.height * 4)}/{mb(doc.layerBytes)} · History {mb(doc.historyBytes)}
      </span>
      {doc.selection && (
        <>
          <span className="sep-v" />
          <span>
            Selection {doc.selection.bounds.w} × {doc.selection.bounds.h}
          </span>
        </>
      )}
      <span className="spacer" />
      <span ref={posRef} className="mono" />
      <span ref={swRef} className="ed-status-swatch" />
      <span ref={colRef} className="mono" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Panel dock

function TabGroup({ tabs, style, initial = 0 }: { tabs: { id: string; label: string; body: () => ReactNode }[]; style?: React.CSSProperties; initial?: number }) {
  const [active, setActive] = useState(tabs[initial].id);
  const [collapsed, setCollapsed] = useState(false);
  const t = tabs.find((x) => x.id === active) ?? tabs[0];
  return (
    <div className={cx('ed-group', collapsed && 'collapsed')} style={collapsed ? undefined : style}>
      <div className="ed-group-tabs">
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            className={cx('ed-group-tab', x.id === t.id && 'active')}
            onClick={() => {
              setActive(x.id);
              setCollapsed(false);
            }}
            onDoubleClick={() => setCollapsed(!collapsed)}
          >
            {x.label}
          </button>
        ))}
        <span className="spacer" />
        <button type="button" className="ed-group-collapse" title={collapsed ? 'Expand' : 'Collapse'} onClick={() => setCollapsed(!collapsed)}>
          <Icon name={collapsed ? 'chevronDown' : 'chevronUp'} size={11} />
        </button>
      </div>
      {!collapsed && <div className="ed-group-body">{t.body()}</div>}
    </div>
  );
}

export function PanelDock() {
  return (
    <div className="ed-dock">
      <TabGroup
        style={{ flex: '0 0 auto', maxHeight: 330 }}
        tabs={[
          { id: 'color', label: 'Color', body: () => <ColorPanel /> },
          { id: 'swatches', label: 'Swatches', body: () => <SwatchesPanel /> },
          { id: 'nav', label: 'Navigator', body: () => <NavigatorPanel /> },
        ]}
      />
      <TabGroup
        style={{ flex: '1 1 0', minHeight: 140 }}
        tabs={[
          { id: 'props', label: 'Properties', body: () => <PropertiesPanel /> },
          { id: 'history', label: 'History', body: () => <HistoryPanel /> },
        ]}
      />
      <TabGroup style={{ flex: '1.4 1 0', minHeight: 200 }} tabs={[{ id: 'layers', label: 'Layers', body: () => <LayersPanel /> }]} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Empty state

export function EmptyState() {
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    void recentFiles().then(setRecent);
  }, []);
  return (
    <div className="ed-empty">
      <div className="ed-empty-card">
        <h2>Edit</h2>
        <p className="muted">Layered image editing — open an image or PSD, or start from a blank canvas. You can also drop files here.</p>
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          <Button variant="primary" icon="plus" onClick={A.newDoc}>
            New Document…
          </Button>
          <Button icon="folder" onClick={A.open}>
            Open…
          </Button>
        </div>
        {recent.length > 0 && (
          <div className="ed-recent">
            <div className="panel-sub">Recent</div>
            {recent.slice(0, 8).map((p) => (
              <button key={p} type="button" className="ed-recent-item" title={p} onClick={() => void openPath(p)}>
                <Icon name="image" size={13} />
                <span className="ellipsis">{basename(p)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
