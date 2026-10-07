// Bundles the Electron main + preload scripts with esbuild.
import { build } from 'esbuild';

const dev = process.argv.includes('--dev');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'warning',
};

await Promise.all([
  build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.js' }),
  build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.js' }),
]);
console.log('[electron] built main + preload');
