import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './ui/theme.css';

createRoot(document.getElementById('root')!).render(<App />);

// Dev-only handle on the live app modules (for debugging from the console).
if (import.meta.env.DEV) {
  void Promise.all([import('./platform/api'), import('./state/catalog'), import('./state/app'), import('./app/bridge'), import('./app/commands')]).then(
    ([api, catalog, app, bridge, commands]) => ((window as any).__lp = { ...api, ...catalog, ...app, ...bridge, ...commands }),
  );
}
