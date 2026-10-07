import { useState } from 'react';
import { openMenu } from '@/state/app';
import { ColorPickerBody } from '@/ui/ColorPicker';
import { Popover } from '@/ui/overlays';
import { cx } from '@/ui/controls';
import { rgbaToCss } from '@/core/util/color';
import { setBg, setFg, TOOL_GROUPS, TOOL_LABELS, useEditor } from '../model/store';
import { A, switchTool } from '../actions';
import { EdIcon, TOOL_ICONS } from './icons';

const SEPARATE_AFTER = new Set(['eyedropper', 'dodge', 'shape']);

export function Toolbox() {
  const tool = useEditor((s) => s.tool);
  const groupTool = useEditor((s) => s.groupTool);
  const fg = useEditor((s) => s.fg);
  const bg = useEditor((s) => s.bg);
  const [picker, setPicker] = useState<null | { which: 'fg' | 'bg'; x: number; y: number }>(null);

  return (
    <div className="ed-toolbox">
      {TOOL_GROUPS.map((g) => {
        const shown = groupTool[g.id] ?? g.tools[0];
        const active = g.tools.includes(tool);
        const multi = g.tools.length > 1;
        const showMenu = (e: React.MouseEvent) => {
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(
            r.right + 4,
            r.top,
            g.tools.map((t) => ({
              label: TOOL_LABELS[t],
              shortcut: g.key.toUpperCase(),
              checked: t === tool,
              icon: <EdIcon name={TOOL_ICONS[t]} size={14} />,
              onClick: () => switchTool(t),
            })),
          );
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        return (
          <div key={g.id} className="ed-tool-wrap">
            <button
              type="button"
              className={cx('ed-tool', active && 'active')}
              title={`${TOOL_LABELS[shown]} (${g.key.toUpperCase()})${multi ? ' — right-click or hold for more' : ''}`}
              onClick={() => switchTool(shown)}
              onContextMenu={multi ? showMenu : (e) => e.preventDefault()}
              onPointerDown={(e) => {
                if (!multi || e.button !== 0) return;
                const target = e.currentTarget;
                timer = setTimeout(() => showMenu({ preventDefault() {}, currentTarget: target } as unknown as React.MouseEvent), 380);
              }}
              onPointerUp={() => clearTimeout(timer)}
              onPointerLeave={() => clearTimeout(timer)}
              onDoubleClick={() => {
                if (g.id === 'hand') A.fit();
                if (g.id === 'zoom') A.actual();
              }}
            >
              <EdIcon name={TOOL_ICONS[shown]} size={17} />
              {multi && <span className="corner" />}
            </button>
            {SEPARATE_AFTER.has(g.id) && <div className="ed-tool-sep" />}
          </div>
        );
      })}
      <div className="spacer" />
      <div className="ed-colors">
        <button
          type="button"
          className="ed-color bg"
          style={{ background: rgbaToCss(bg) }}
          title="Background color"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setPicker({ which: 'bg', x: r.right + 6, y: r.top - 120 });
          }}
        />
        <button
          type="button"
          className="ed-color fg"
          style={{ background: rgbaToCss(fg) }}
          title="Foreground color"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setPicker({ which: 'fg', x: r.right + 6, y: r.top - 120 });
          }}
        />
        <button type="button" className="ed-color-swap" title="Switch colors (X)" onClick={A.swapColors}>
          <EdIcon name="swap" size={11} />
        </button>
        <button type="button" className="ed-color-reset" title="Default colors (D)" onClick={A.resetColors}>
          <span />
          <span />
        </button>
      </div>
      {picker && (
        <Popover x={picker.x} y={picker.y} onClose={() => setPicker(null)}>
          <div className="ed-picker-title">{picker.which === 'fg' ? 'Foreground Color' : 'Background Color'}</div>
          <ColorPickerBody value={picker.which === 'fg' ? fg : bg} alpha={false} onChange={(c) => (picker.which === 'fg' ? setFg(c) : setBg(c))} />
        </Popover>
      )}
    </div>
  );
}
