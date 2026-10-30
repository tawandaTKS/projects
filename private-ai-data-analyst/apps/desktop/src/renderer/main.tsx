import { createRoot } from 'react-dom/client';
import { App } from '@pada/ui';
import { createDesktopPlatform } from './desktopPlatform';

createRoot(document.getElementById('root')!).render(<App platform={createDesktopPlatform()} />);
