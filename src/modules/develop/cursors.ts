/** Custom CSS cursors (leaf module — no imports, safe to use at module top level anywhere). */

const ROTATE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M5 12a7 7 0 0 1 12-4.9M19 12a7 7 0 0 1-12 4.9" fill="none" stroke="#000" stroke-width="4"/><path d="M5 12a7 7 0 0 1 12-4.9M19 12a7 7 0 0 1-12 4.9" fill="none" stroke="#fff" stroke-width="1.6"/><path d="M17 3v4.5h-4.5M7 21v-4.5h4.5" fill="none" stroke="#fff" stroke-width="1.6"/></svg>';

export const CURSORS = {
  rotate: `url("data:image/svg+xml,${encodeURIComponent(ROTATE_SVG)}") 12 12, crosshair`,
};
