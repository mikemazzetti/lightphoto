import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  // libraw-wasm resolves its worker + wasm relative to import.meta.url; pre-bundling would break that.
  optimizeDeps: { exclude: ['libraw-wasm'] },
  worker: { format: 'es' },
  // Cross-origin isolation enables SharedArrayBuffer, which the threaded RAW decoder needs.
  server: {
    port: 5173,
    strictPort: true,
    // LP_NO_HMR=1 gives a stable page for automated UI testing while files are being edited.
    hmr: process.env.LP_NO_HMR ? false : undefined,
    watch: process.env.LP_NO_HMR ? null : undefined,
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  preview: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  build: {
    outDir: 'dist',
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});
