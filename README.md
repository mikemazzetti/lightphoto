# LightPhoto Studio

A cross-platform (macOS + Windows) desktop suite combining a **photo library & RAW developer**
(Lightroom-style), a **layered image editor** (Photoshop-style) and a **non-linear video editor**
(Premiere-style). All pixel work runs on the GPU.

## Run it

Requirements: Node 20.19+ (or 22.12+).

```bash
npm install
npm run dev          # Vite dev server + Electron with hot reload
```

The UI also runs in a plain browser at http://localhost:5173 for quick UI work (file access then
falls back to file pickers and downloads).

## Build installers

```bash
npm run dist:mac     # → release/*.dmg   (run on macOS)
npm run dist:win     # → release/*.exe   (run on Windows, or macOS with Wine)
```

Installers are unsigned. For distribution, add an Apple Developer ID / Windows code-signing
certificate in the `build` section of `package.json` (see electron-builder docs).

## Workspaces

| Workspace | Like | Highlights |
| --- | --- | --- |
| **Library** | Lightroom Library | Import files/folders, virtualized grid for very large catalogs, ratings, flags, colour labels, collections, filters, EXIF, batch export |
| **Develop** | Lightroom Develop / Camera Raw | Non-destructive GPU pipeline: white balance, tone, presence, tone curve, colour mixer, colour grading, detail, lens, effects, crop/straighten, linear/radial/brush masks, presets, history |
| **Edit** | Photoshop | Layers with 27 blend modes, masks, adjustment layers, painting & retouching tools, selections, filters, PSD open/save |
| **Video** | Premiere Pro | Media bin, multi-track timeline, trimming/razor/ripple, transitions, titles, Lumetri-style colour, keyframes, hardware-accelerated MP4/WebM export |

Press **⌘/** (Ctrl+/) in the app for the keyboard shortcut list.

## Supported formats

- Photos: JPEG, PNG, WebP, AVIF, GIF, BMP, TIFF, PSD (composite and layers), HEIC (macOS),
  and camera RAW via LibRaw (CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2, PEF, …).
- Video/audio: whatever Chromium decodes (H.264, HEVC where the OS supports it, VP8/9, AV1, AAC,
  MP3, Opus, FLAC, WAV).

## Architecture

```
electron/            main process: window, native menus, file dialogs, lp:// local-file protocol
                     (HTTP range support for video seeking), user-data store, thumbnail cache
src/platform/api.ts  the only bridge to the OS (with a browser fallback)
src/core/gl/         WebGL2 toolkit (textures, render targets, shaders) + GLSL colour/blend libraries
src/core/develop/    the GPU develop engine shared by Develop, Edit (Camera Raw filter) and Video (colour)
src/core/image/      decoding (incl. RAW via WebAssembly LibRaw in a worker), thumbnails, encoding
src/ui/              shared UI kit (sliders, panels, menus, dialogs, colour picker, curve editor, viewport)
src/state/           app-wide state (toasts, tasks, dialogs) and the photo catalog
src/modules/         library/ develop/ editor/ video/ workspaces (+ shared/ thumbnails & filmstrip)
```

### Why it's fast

- **One GPU pipeline per image.** The develop engine runs geometry, a blur pyramid, noise
  reduction and a single fused "main" shader. Geometry-dependent passes are cached, so dragging a
  tone or colour slider re-runs one full-screen pass (≈9 ms for a 6 MP preview on an M-series GPU).
- **Preview-resolution rendering.** Images render at on-screen resolution and only go to full
  resolution when zoomed in or exported. Sources are mip-mapped on upload.
- **16-bit RAW path.** RAW files decode to 16-bit and are processed in half-float linear light.
- **Off-thread decoding.** RAW decoding runs in a WebAssembly worker (multi-threaded via
  SharedArrayBuffer — the app is cross-origin isolated for this); thumbnails are generated with
  bounded concurrency and cached on disk.
- **Hardware video.** Playback uses the platform decoders; export encodes through WebCodecs.

## Development notes

- `npm run typecheck` — TypeScript across the whole project.
- `test-media/` holds generated test files (synthetic DNG, two MP4s, an MP3, a PNG); `test.html`
  is a dev-only GPU/RAW decode harness (`http://localhost:5173/test.html?t=raw`).
- `LP_NO_HMR=1 npx vite --port 5174` serves a dev build without hot reload (stable for automated
  UI testing). In dev builds, `window.__lp` exposes the live stores/APIs for debugging.
- `LP_SMOKE=1 LP_SHOT=out.png npx electron .` boots the built app hidden, runs self-checks
  (native bridge, cross-origin isolation, WebGL2, WebCodecs, lp:// range requests), optionally
  saves a window capture, prints `SMOKE {...}` and exits.

## Status

Verified end-to-end in the app: library import/grid/rating/quick-develop (incl. RAW thumbnails),
20k-photo catalog responsiveness, Develop rendering/sliders/presets/history/crop/masks, Edit
layers/brush/Camera Raw filter/blend modes/history, Video import/timeline/playback/split/undo/
Lumetri/MP4 export (H.264 + AAC), packaged macOS app boot.

Known limitations (not yet implemented or simplified):

- Develop: no AI/range/subject masks; white-balance presets are relative (no Kelvin); panel
  on/off switches are preview-only.
- Edit: no layer groups (PSD groups flatten), smart objects, perspective/warp transform, rulers or
  quick mask; layer styles are drawn in Normal mode.
- Video: one sequence per project (no nesting/bins); exports of speed-changed clips are
  pitch-shifted; codecs Chromium can't decode (e.g. ProRes) show black; reverse shuttle is choppy.
- HEIC decoding uses macOS `sips` (not available on Windows).
- Installers are unsigned.
