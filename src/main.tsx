import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './index.css';
import { openAppStorage } from './data/db';
import { Repo } from './data/repo';
import { Services } from './app/services';
import { StoreProvider } from './ui/store';
import { App } from './ui/App';
import { AutoSync } from './ui/components/AutoSync';

registerSW({ immediate: true });

async function start() {
  const root = createRoot(document.getElementById('root')!);
  try {
    if (navigator.storage?.persist) void navigator.storage.persist(); // ask Chrome not to evict IndexedDB
    const storage = await openAppStorage();
    const svc = new Services(new Repo(storage));
    root.render(
      <StrictMode>
        <StoreProvider svc={svc}>
          <AutoSync />
          <App />
        </StoreProvider>
      </StrictMode>,
    );
  } catch (e) {
    root.render(
      <div style={{ padding: 24, fontFamily: 'system-ui' }}>
        <h1>Climb Coach could not start</h1>
        <p>{e instanceof Error ? e.message : String(e)}</p>
        <p>Your data is untouched. Reload the page; if the problem persists, export a backup from another device and open an issue.</p>
      </div>,
    );
  }
}

void start();
