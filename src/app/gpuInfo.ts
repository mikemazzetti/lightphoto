import { api } from '@/platform/api';

/** Basic system/GPU capabilities for the About dialog and diagnostics. */
export function gpuInfo(): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      out['GPU'] = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      out['Max texture size'] = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      out['Float render targets'] = !!gl.getExtension('EXT_color_buffer_float');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } else out['GPU'] = 'WebGL2 unavailable';
  } catch {
    out['GPU'] = 'unknown';
  }
  out['WebCodecs'] = typeof (globalThis as any).VideoEncoder === 'function';
  out['WebGPU'] = 'gpu' in navigator;
  out['Cross-origin isolated'] = (globalThis as any).crossOriginIsolated === true;
  out['CPU threads'] = navigator.hardwareConcurrency;
  out['Platform'] = api.platform + (api.isElectron ? ' (desktop)' : ' (browser)');
  return out;
}
