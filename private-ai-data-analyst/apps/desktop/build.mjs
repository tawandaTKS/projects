// Bundles the Electron main + preload processes. The renderer is built by Vite.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const buildDate = process.env.PADA_BUILD_DATE ?? new Date().toISOString().slice(0, 10);
const release = process.argv.includes('--release');

if (release) {
  const keyFile = readFileSync(new URL('../../packages/core/src/licenseKey.ts', import.meta.url), 'utf8');
  const LICENSE_PUBLIC_KEY_HEX = /LICENSE_PUBLIC_KEY_HEX = '([0-9a-f]*)'/.exec(keyFile)?.[1] ?? '';
  if (!LICENSE_PUBLIC_KEY_HEX) {
    console.error('Release build refused: no licence public key. Run `npm run license:keygen` first.');
    process.exit(1);
  }
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: !release,
  minify: release,
  external: ['electron', '@duckdb/node-api'],
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __BUILD_DATE__: JSON.stringify(buildDate) },
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.cjs' });
await build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.cjs' });
