/**
 * Thin, fast WebGL2 toolkit shared by every module.
 *
 * Conventions
 *  - "Image space": texture coordinate (0,0) is the TOP-LEFT of the image. Textures uploaded
 *    without UNPACK_FLIP_Y and all render targets follow this, so passes chain naturally and
 *    readPixels() returns rows top-first (same as ImageData).
 *  - Only the final draw to the default framebuffer (the visible canvas) needs a Y flip; use
 *    `Shader.draw(null, …)` together with `uFlipY = 1` in your present shader, or the helpers in
 *    `present.ts`.
 *  - Full-screen passes use a single oversized triangle (no vertex buffers): `vUv` in the
 *    fragment shader is 0..1 across the target.
 */

export type GL = WebGL2RenderingContext;

export interface GLCaps {
  floatRT: boolean; // can render to RGBA16F/RGBA32F
  floatLinear: boolean; // RGBA32F filterable
  maxTextureSize: number;
  maxArrayLayers: number;
  anisotropy: number;
  anisoExt: EXT_texture_filter_anisotropic | null;
}

const capsMap = new WeakMap<GL, GLCaps>();

export function createGL(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  opts: { alpha?: boolean; preserveDrawingBuffer?: boolean; desynchronized?: boolean } = {},
): GL {
  const gl = canvas.getContext('webgl2', {
    alpha: opts.alpha ?? false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    powerPreference: 'high-performance',
    desynchronized: opts.desynchronized ?? false,
  }) as GL | null;
  if (!gl) throw new Error('WebGL2 is not available on this system.');
  const floatRT = !!gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('EXT_color_buffer_half_float');
  const floatLinear = !!gl.getExtension('OES_texture_float_linear');
  const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
  capsMap.set(gl, {
    floatRT,
    floatLinear,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
    anisotropy: anisoExt ? gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1,
    anisoExt,
  });
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  return gl;
}

export function caps(gl: GL): GLCaps {
  let c = capsMap.get(gl);
  if (!c) {
    // Context not created via createGL: probe lazily.
    const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    c = {
      floatRT: !!gl.getExtension('EXT_color_buffer_float'),
      floatLinear: !!gl.getExtension('OES_texture_float_linear'),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
      anisotropy: anisoExt ? gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1,
      anisoExt,
    };
    capsMap.set(gl, c);
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// Textures

export type TexFormat = 'rgba8' | 'srgb8' | 'rgba16f' | 'rgba32f' | 'r8' | 'r16f' | 'rg16f' | 'rgb16ui' | 'rgba16ui';
export type TexFilter = 'linear' | 'nearest' | 'mipmap';
export type TexWrap = 'clamp' | 'repeat' | 'mirror';

interface FormatInfo {
  internal: number;
  format: number;
  type: number;
  bpp: number;
  integer?: boolean;
}

function formatInfo(gl: GL, f: TexFormat): FormatInfo {
  switch (f) {
    case 'rgba8':
      return { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, bpp: 4 };
    case 'srgb8':
      return { internal: gl.SRGB8_ALPHA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, bpp: 4 };
    case 'rgba16f':
      return { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, bpp: 8 };
    case 'rgba32f':
      return { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, bpp: 16 };
    case 'r8':
      return { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, bpp: 1 };
    case 'r16f':
      return { internal: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT, bpp: 2 };
    case 'rg16f':
      return { internal: gl.RG16F, format: gl.RG, type: gl.HALF_FLOAT, bpp: 4 };
    case 'rgb16ui':
      return { internal: gl.RGB16UI, format: gl.RGB_INTEGER, type: gl.UNSIGNED_SHORT, bpp: 6, integer: true };
    case 'rgba16ui':
      return { internal: gl.RGBA16UI, format: gl.RGBA_INTEGER, type: gl.UNSIGNED_SHORT, bpp: 8, integer: true };
  }
}

export interface TextureOptions {
  format?: TexFormat;
  filter?: TexFilter;
  wrap?: TexWrap;
  /** Raw pixel data (rows top-first). */
  data?: ArrayBufferView | null;
}

let liveTextureBytes = 0;
export const gpuMemory = () => liveTextureBytes;

export class Texture {
  readonly tex: WebGLTexture;
  readonly info: FormatInfo;
  private bytes = 0;
  private mipmapped = false;

  constructor(
    readonly gl: GL,
    public width: number,
    public height: number,
    readonly format: TexFormat = 'rgba8',
    public filter: TexFilter = 'linear',
    public wrap: TexWrap = 'clamp',
  ) {
    this.tex = gl.createTexture()!;
    this.info = formatInfo(gl, format);
    if (this.info.integer) this.filter = 'nearest';
    this.applyParams();
  }

  static create(gl: GL, width: number, height: number, opts: TextureOptions = {}): Texture {
    const t = new Texture(gl, width, height, opts.format ?? 'rgba8', opts.filter ?? 'linear', opts.wrap ?? 'clamp');
    t.allocate(width, height, opts.data ?? null);
    return t;
  }

  /** Uploads an image/canvas/video/bitmap. 8-bit sources default to sRGB storage (linear sampling). */
  static fromSource(gl: GL, src: TexImageSource, opts: { format?: TexFormat; filter?: TexFilter; wrap?: TexWrap } = {}): Texture {
    const { width, height } = sourceSize(src);
    const t = new Texture(gl, width, height, opts.format ?? 'rgba8', opts.filter ?? 'linear', opts.wrap ?? 'clamp');
    t.upload(src);
    return t;
  }

  private applyParams() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const min = this.filter === 'mipmap' ? gl.LINEAR_MIPMAP_LINEAR : this.filter === 'linear' ? gl.LINEAR : gl.NEAREST;
    const mag = this.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    const wrap = this.wrap === 'repeat' ? gl.REPEAT : this.wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    const c = caps(gl);
    if (this.filter === 'mipmap' && c.anisoExt) gl.texParameterf(gl.TEXTURE_2D, c.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, c.anisotropy));
  }

  setFilter(filter: TexFilter) {
    if (this.info.integer || filter === this.filter) return;
    this.filter = filter;
    this.applyParams();
    if (filter === 'mipmap' && !this.mipmapped) this.generateMipmaps();
  }

  private track(bytes: number) {
    liveTextureBytes += bytes - this.bytes;
    this.bytes = bytes;
  }

  allocate(width: number, height: number, data: ArrayBufferView | null = null) {
    const gl = this.gl;
    this.width = width;
    this.height = height;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.info.internal, width, height, 0, this.info.format, this.info.type, data);
    this.mipmapped = false;
    this.track(width * height * this.info.bpp);
    if (this.filter === 'mipmap' && data) this.generateMipmaps();
  }

  /** Re-specifies storage from a DOM source (resizes if needed). */
  upload(src: TexImageSource) {
    const gl = this.gl;
    const { width, height } = sourceSize(src);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (width === this.width && height === this.height && this.bytes > 0) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.info.format, this.info.type, src);
    } else {
      this.width = width;
      this.height = height;
      gl.texImage2D(gl.TEXTURE_2D, 0, this.info.internal, this.info.format, this.info.type, src);
      this.track(width * height * this.info.bpp);
    }
    this.mipmapped = false;
    if (this.filter === 'mipmap') this.generateMipmaps();
  }

  /** Updates a sub-rectangle from raw data or a DOM source. */
  uploadRegion(x: number, y: number, w: number, h: number, src: ArrayBufferView | TexImageSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (ArrayBuffer.isView(src)) gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, this.info.format, this.info.type, src);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, this.info.format, this.info.type, src);
    if (this.filter === 'mipmap') this.generateMipmaps();
  }

  /** Marks mip levels stale (called when the texture is rendered into). */
  invalidateMips() {
    this.mipmapped = false;
  }

  generateMipmaps() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.mipmapped = true;
  }

  bind(unit: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
  }

  dispose() {
    this.gl.deleteTexture(this.tex);
    this.track(0);
  }
}

export function sourceSize(src: TexImageSource): { width: number; height: number } {
  if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) return { width: src.videoWidth, height: src.videoHeight };
  if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) return { width: src.naturalWidth, height: src.naturalHeight };
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) return { width: src.displayWidth, height: src.displayHeight };
  return { width: (src as any).width, height: (src as any).height };
}

// ---------------------------------------------------------------------------------------------
// Render targets

export class RenderTarget {
  readonly fbo: WebGLFramebuffer;
  readonly texture: Texture;

  constructor(readonly gl: GL, width: number, height: number, format: TexFormat = 'rgba8', filter: TexFilter = 'linear', wrap: TexWrap = 'clamp') {
    format = renderableFormat(gl, format);
    this.texture = Texture.create(gl, width, height, { format, filter, wrap });
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  get width() {
    return this.texture.width;
  }
  get height() {
    return this.texture.height;
  }

  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    this.texture.invalidateMips();
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.texture.allocate(width, height);
  }

  clear(r = 0, g = 0, b = 0, a = 0) {
    const gl = this.gl;
    this.bind();
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Synchronous readback (rows top-first). For RGBA8 targets returns Uint8Array, float targets Float32Array. */
  read(x = 0, y = 0, w = this.width, h = this.height): Uint8Array | Float32Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const isFloat = this.texture.info.type !== gl.UNSIGNED_BYTE;
    const out = isFloat ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, isFloat ? gl.FLOAT : gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Reads an RGBA8 target into ImageData (handy for export / Canvas2D interop). */
  toImageData(): ImageData {
    const data = this.read() as Uint8Array;
    return new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength), this.width, this.height);
  }

  dispose() {
    this.gl.deleteFramebuffer(this.fbo);
    this.texture.dispose();
  }
}

/** Float formats fall back to RGBA8 when the GPU can't render to them. */
export function renderableFormat(gl: GL, format: TexFormat): TexFormat {
  return (format === 'rgba16f' || format === 'rgba32f' || format === 'r16f' || format === 'rg16f') && !caps(gl).floatRT ? 'rgba8' : format;
}

/** Reuses render targets by (size, format) to avoid allocation churn during interactive editing. */
export class TargetPool {
  private free: RenderTarget[] = [];
  constructor(readonly gl: GL) {}
  acquire(width: number, height: number, format: TexFormat = 'rgba8', filter: TexFilter = 'linear'): RenderTarget {
    format = renderableFormat(this.gl, format);
    const i = this.free.findIndex((t) => t.width === width && t.height === height && t.texture.format === format);
    if (i >= 0) {
      const t = this.free.splice(i, 1)[0];
      t.texture.setFilter(filter);
      return t;
    }
    return new RenderTarget(this.gl, width, height, format, filter);
  }
  release(t: RenderTarget | null | undefined) {
    if (!t) return;
    this.free.push(t);
    while (this.free.length > 12) this.free.shift()!.dispose();
  }
  dispose() {
    this.free.forEach((t) => t.dispose());
    this.free = [];
  }
}

// ---------------------------------------------------------------------------------------------
// Shaders

export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export type UniformValue =
  | number
  | boolean
  | readonly number[]
  | Float32Array
  | Int32Array
  | Texture
  | RenderTarget
  | { tex: WebGLTexture; array?: boolean };

interface UniformInfo {
  loc: WebGLUniformLocation;
  type: number;
  size: number;
  unit?: number;
}

function compile(gl: GL, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const numbered = src
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(4)}: ${l}`)
      .join('\n');
    console.error(numbered);
    throw new Error('Shader compile error: ' + log);
  }
  return s;
}

const vaoFor = new WeakMap<GL, WebGLVertexArrayObject>();

export class Shader {
  readonly program: WebGLProgram;
  private uniforms = new Map<string, UniformInfo>();

  constructor(readonly gl: GL, fragSrc: string, vertSrc: string = FULLSCREEN_VS) {
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vertSrc));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader link error: ' + gl.getProgramInfoLog(p));
    this.program = p;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    let unit = 0;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i)!;
      const name = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(p, info.name)!;
      const u: UniformInfo = { loc, type: info.type, size: info.size };
      if (isSampler(gl, info.type)) u.unit = unit++;
      this.uniforms.set(name, u);
    }
  }

  use(): this {
    this.gl.useProgram(this.program);
    return this;
  }

  has(name: string) {
    return this.uniforms.has(name);
  }

  /** Sets uniforms by name; unknown names are ignored (lets callers share uniform bags). */
  set(values: Record<string, UniformValue | undefined>): this {
    const gl = this.gl;
    gl.useProgram(this.program);
    for (const name in values) {
      const v = values[name];
      if (v === undefined || v === null) continue;
      const u = this.uniforms.get(name);
      if (!u) continue;
      if (u.unit !== undefined) {
        gl.activeTexture(gl.TEXTURE0 + u.unit);
        if (v instanceof Texture) gl.bindTexture(gl.TEXTURE_2D, v.tex);
        else if (v instanceof RenderTarget) gl.bindTexture(gl.TEXTURE_2D, v.texture.tex);
        else if (typeof v === 'object' && 'tex' in v) gl.bindTexture(v.array ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, v.tex);
        gl.uniform1i(u.loc, u.unit);
        continue;
      }
      setUniform(gl, u, v as number | boolean | readonly number[] | Float32Array | Int32Array);
    }
    return this;
  }

  /** Draws a full-screen pass into `target` (null = default framebuffer, sized to the canvas drawing buffer). */
  draw(target: RenderTarget | null, values?: Record<string, UniformValue | undefined>, viewport?: [number, number, number, number]) {
    const gl = this.gl;
    if (target) target.bind();
    else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
    if (viewport) gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    this.use();
    if (values) this.set(values);
    let vao = vaoFor.get(gl);
    if (!vao) {
      vao = gl.createVertexArray()!;
      vaoFor.set(gl, vao);
    }
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    this.gl.deleteProgram(this.program);
  }
}

function isSampler(gl: GL, t: number) {
  const samplers: number[] = [
    gl.SAMPLER_2D, gl.SAMPLER_2D_ARRAY, gl.SAMPLER_3D, gl.SAMPLER_CUBE, gl.SAMPLER_2D_SHADOW, gl.SAMPLER_2D_ARRAY_SHADOW, gl.SAMPLER_CUBE_SHADOW,
    gl.INT_SAMPLER_2D, gl.INT_SAMPLER_2D_ARRAY, gl.INT_SAMPLER_3D, gl.INT_SAMPLER_CUBE,
    gl.UNSIGNED_INT_SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_2D_ARRAY, gl.UNSIGNED_INT_SAMPLER_3D, gl.UNSIGNED_INT_SAMPLER_CUBE,
  ];
  return samplers.includes(t);
}

function setUniform(gl: GL, u: UniformInfo, v: number | boolean | readonly number[] | Float32Array | Int32Array) {
  const arr = typeof v === 'number' || typeof v === 'boolean' ? null : (v as ArrayLike<number>);
  const num = typeof v === 'boolean' ? (v ? 1 : 0) : (v as number);
  switch (u.type) {
    case gl.FLOAT:
      arr ? gl.uniform1fv(u.loc, arr as Float32List) : gl.uniform1f(u.loc, num);
      break;
    case gl.FLOAT_VEC2:
      gl.uniform2fv(u.loc, arr as Float32List);
      break;
    case gl.FLOAT_VEC3:
      gl.uniform3fv(u.loc, arr as Float32List);
      break;
    case gl.FLOAT_VEC4:
      gl.uniform4fv(u.loc, arr as Float32List);
      break;
    case gl.INT:
    case gl.BOOL:
      arr ? gl.uniform1iv(u.loc, Int32Array.from(arr)) : gl.uniform1i(u.loc, num);
      break;
    case gl.INT_VEC2:
      gl.uniform2iv(u.loc, Int32Array.from(arr!));
      break;
    case gl.INT_VEC4:
      gl.uniform4iv(u.loc, Int32Array.from(arr!));
      break;
    case gl.FLOAT_MAT3:
      gl.uniformMatrix3fv(u.loc, false, arr as Float32List);
      break;
    case gl.FLOAT_MAT4:
      gl.uniformMatrix4fv(u.loc, false, arr as Float32List);
      break;
    default:
      console.warn('Unsupported uniform type', u.type);
  }
}

/** Builds and caches one Shader per (gl, key). */
const shaderCache = new WeakMap<GL, Map<string, Shader>>();
export function cachedShader(gl: GL, key: string, frag: string, vert?: string): Shader {
  let m = shaderCache.get(gl);
  if (!m) shaderCache.set(gl, (m = new Map()));
  let s = m.get(key);
  if (!s) m.set(key, (s = new Shader(gl, frag, vert)));
  return s;
}

/** Simple copy shader (optionally flips Y when drawing to screen). */
export const COPY_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform float uFlipY;
void main(){ vec2 uv = vUv; if (uFlipY > 0.5) uv.y = 1.0 - uv.y; o = texture(uTex, uv); }`;

export function copyTexture(gl: GL, src: Texture | RenderTarget, dst: RenderTarget | null) {
  cachedShader(gl, 'copy', COPY_FS).draw(dst, { uTex: src, uFlipY: dst ? 0 : 1 });
}
