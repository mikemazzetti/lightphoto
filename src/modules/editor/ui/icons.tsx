import type { CSSProperties } from 'react';
import { Icon, IconName } from '@/ui/Icon';
import type { ToolId } from '../model/store';

/** Extra 24×24 stroke icons for tools the shared icon set doesn't cover. */
const EXTRA = {
  lassoPoly: '<path d="M4 18L7 5l7 4 6-3-2 9-8 3z"/><circle cx="4" cy="18" r="1.6" fill="currentColor"/>',
  spotHeal: '<rect x="3" y="8" width="18" height="8" rx="4" transform="rotate(-45 12 12)"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="9.5" cy="12" r=".8" fill="currentColor"/><circle cx="14.5" cy="12" r=".8" fill="currentColor"/>',
  blur: '<path d="M12 3c-3 4.2-5.5 7.3-5.5 10.5a5.5 5.5 0 0 0 11 0C17.5 10.3 15 7.2 12 3z"/>',
  sharpen: '<path d="M12 3l6 18H6z"/>',
  smudge: '<path d="M9 21v-7.5a2 2 0 0 1 4 0V16"/><path d="M13 13V5a2 2 0 0 1 4 0v9"/><path d="M17 12.5a2 2 0 0 1 4 0V16a5 5 0 0 1-5 5H9"/><path d="M9 16l-3-3a1.8 1.8 0 0 0-2.6 2.6L8 20"/>',
  dodge: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="M12.5 12.5L21 21"/>',
  burn: '<path d="M7 20c-1.6-1-3-2.7-3-5 0-2.5 2-4 2-6.5 0 0 2 1.2 2 3.5 1-2 3-3.5 3-7 0 0 6 3.5 6 9.5a6 6 0 0 1-3 5.2"/><path d="M10.5 20.5c-1.2-.6-2-1.8-2-3.2 0-1.8 1.5-2.8 1.5-4.3 0 0 3.5 1.8 3.5 4.8 0 1.2-.6 2.2-1.5 2.8"/>',
  sponge: '<rect x="4" y="7" width="16" height="11" rx="3"/><circle cx="8.5" cy="11" r="1" fill="currentColor"/><circle cx="13" cy="13.5" r="1" fill="currentColor"/><circle cx="16" cy="10.5" r=".9" fill="currentColor"/><circle cx="10" cy="15" r=".8" fill="currentColor"/>',
  roundRect: '<rect x="3.5" y="5" width="17" height="14" rx="4"/>',
  swap: '<path d="M7 4h9a3 3 0 0 1 3 3v8"/><path d="M16 12l3 3 3-3"/><path d="M4 7l3-3 3 3"/>',
  maskAdd: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="5"/>',
  adjustLayer: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
  newLayer: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8v8M8 12h8"/>',
  chain: '<path d="M9 7H7a5 5 0 0 0 0 10h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><path d="M8 12h8"/>',
  clip: '<path d="M7 5v9a3 3 0 0 0 3 3h9"/><path d="M15 13l4 4-4 4"/>',
  alpha: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h6v6H3zM9 3h6v6H9zM15 9h6v6h-6zM9 15h6v6H9z" fill="currentColor" opacity=".45"/>',
  brushLock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
} as const;

export type ExtraIcon = keyof typeof EXTRA;
export type AnyIcon = IconName | ExtraIcon;

export function EdIcon({ name, size = 16, style, className }: { name: AnyIcon; size?: number; style?: CSSProperties; className?: string }) {
  if (name in EXTRA) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flex: '0 0 auto', ...style }}
        className={className}
        aria-hidden
        dangerouslySetInnerHTML={{ __html: EXTRA[name as ExtraIcon] }}
      />
    );
  }
  return <Icon name={name as IconName} size={size} style={style} className={className} />;
}

export const TOOL_ICONS: Record<ToolId, AnyIcon> = {
  move: 'move',
  marqueeRect: 'marquee',
  marqueeEllipse: 'marqueeEllipse',
  lasso: 'lasso',
  lassoPoly: 'lassoPoly',
  wand: 'wand',
  crop: 'crop',
  eyedropper: 'eyedropper',
  spotHeal: 'spotHeal',
  heal: 'heal',
  brush: 'brush',
  pencil: 'pencil',
  clone: 'stamp',
  eraser: 'eraser',
  gradient: 'gradient',
  bucket: 'bucket',
  blur: 'blur',
  sharpen: 'sharpen',
  smudge: 'smudge',
  dodge: 'dodge',
  burn: 'burn',
  sponge: 'sponge',
  text: 'text',
  shapeRect: 'rect',
  shapeRounded: 'roundRect',
  shapeEllipse: 'ellipse',
  shapeLine: 'line',
  hand: 'hand',
  zoom: 'zoom',
};
