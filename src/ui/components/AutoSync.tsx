/** Invisible component: runs backup + sync in the background and refreshes the UI after a pull. */
import { useEffect, useRef } from 'react';
import { backgroundTick } from '../../sync/autoSync';
import { useStore } from '../store';

export function AutoSync() {
  const { svc, data, refresh } = useStore();
  const first = useRef(true);
  const busy = useRef(false);

  const tick = useRef(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await backgroundTick(svc.repo);
      if (r.changed) await refresh(); // refresh only on new data: avoids a sync <-> refresh loop
    } finally {
      busy.current = false;
    }
  });

  useEffect(() => {
    void tick.current();
    const onVis = () => {
      if (document.visibilityState === 'visible') void tick.current();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onVis);
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void tick.current();
    }, 10 * 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onVis);
      clearInterval(id);
    };
  }, []);

  // Push ~20 s after local changes (debounced). `data` changes identity after every mutation.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const id = window.setTimeout(() => void tick.current(), 20_000);
    return () => clearTimeout(id);
  }, [data]);

  return null;
}
