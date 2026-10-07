// Dev runner: starts the Vite dev server, bundles Electron main/preload, launches Electron.
import { createServer } from 'vite';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`[vite] ${url}`);

execFileSync(process.execPath, ['scripts/build-electron.mjs', '--dev'], { stdio: 'inherit' });

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on('close', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
