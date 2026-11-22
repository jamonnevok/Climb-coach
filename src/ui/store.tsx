/**
 * App store: holds the in-memory data snapshot + derived state, and wraps every mutation
 * (`run`) with a refresh and an optional toast. Single user, small data -> reload all.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Services } from '../app/services';
import type { AppData, Derived } from '../app/derive';

export interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error' | 'info';
}

export interface Store {
  svc: Services;
  data: AppData;
  d: Derived;
  ready: boolean;
  refresh: () => Promise<void>;
  run: <T>(fn: () => Promise<T>, okText?: string) => Promise<T | undefined>;
  toast: (text: string, tone?: Toast['tone']) => void;
  toasts: Toast[];
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('Store not ready');
  return s;
}

export function StoreProvider({ svc, children, initial }: { svc: Services; children: ReactNode; initial?: { data: AppData; d: Derived } }) {
  const [state, setState] = useState<{ data: AppData; d: Derived } | null>(initial ?? null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const lastDay = useRef<string>('');

  const refresh = useCallback(async () => {
    const r = await svc.derived();
    lastDay.current = r.d.today;
    setState(r);
  }, [svc]);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3000);
  }, []);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
      try {
        const out = await fn();
        await svc.refreshProposals();
        await refresh();
        if (okText) toast(okText);
        return out;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
        return undefined;
      }
    },
    [svc, refresh, toast],
  );

  useEffect(() => {
    if (initial) return;
    void (async () => {
      await svc.boot();
      await svc.refreshProposals();
      await refresh();
    })();
    // New day / back to the app: re-run daily rules.
    const onVis = () => {
      if (document.visibilityState === 'visible' && svc.today() !== lastDay.current) void svc.refreshProposals().then(refresh);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [svc, refresh, initial]);

  if (!state) {
    return <div className="h-full flex items-center justify-center text-muted">Loading…</div>;
  }
  return <Ctx.Provider value={{ svc, data: state.data, d: state.d, ready: true, refresh, run, toast, toasts }}>{children}</Ctx.Provider>;
}
