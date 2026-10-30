// Dev loop: Vite dev server for the renderer + esbuild for main/preload + Electron.
import { createServer } from 'vite';
import { spawn, execFileSync } from 'node:child_process';
import electron from 'electron';

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0];
execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit' });
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
