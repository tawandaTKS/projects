import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Inside the app the WebView may only load its own bundled files. Model calls use Capacitor's native
// HTTP bridge, and DuckDB-WASM's worker cannot reach the network at all.
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob: data:; form-action 'none'; base-uri 'none'";

const csp = (): Plugin => ({
  name: 'csp',
  transformIndexHtml: {
    order: 'post',
    handler: (html, ctx) => html.replace('<!--CSP-->', ctx.server || process.env.PADA_NO_CSP ? '' : `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  },
});

export default defineConfig({
  plugins: [react(), csp()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_DATE__: JSON.stringify(process.env.PADA_BUILD_DATE ?? new Date().toISOString().slice(0, 10)),
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4000, assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  server: { port: 5174, host: true },
});
