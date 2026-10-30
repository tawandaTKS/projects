import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The packaged renderer may not make any network request at all.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

const csp = (): Plugin => ({
  name: 'csp',
  transformIndexHtml: {
    order: 'post',
    handler: (html, ctx) => html.replace('<!--CSP-->', ctx.server ? '' : `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  },
});

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), csp()],
  build: { outDir: '../../dist/renderer', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { port: 5173, strictPort: true },
});
