import { createRoot } from 'react-dom/client';
import { App } from '@pada/ui';
import { WasmEngine } from './wasmEngine';
import { createMobilePlatform } from './mobilePlatform';

const root = createRoot(document.getElementById('root')!);

WasmEngine.open()
  .then((engine) => root.render(<App platform={createMobilePlatform(engine)} />))
  .catch((e: Error) => {
    document.getElementById('root')!.innerHTML = `<div style="padding:24px;font-family:system-ui"><h2>Could not start the local database</h2><p>${e.message.replace(/</g, '&lt;')}</p></div>`;
  });
