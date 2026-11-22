/**
 * Minimal hash router (GitHub Pages friendly: no server rewrites needed).
 * Routes: #/today, #/plan, #/session/<plannedSessionId>, #/session/test/<exerciseId>,
 * #/log, #/stats, #/body, #/settings, #/onboarding.
 */
import { useEffect, useState } from 'react';

export interface Route {
  path: string;
  parts: string[];
}

function parse(): Route {
  const raw = (typeof location !== 'undefined' ? location.hash : '').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  return { path: parts[0] ?? 'today', parts };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function navigate(path: string): void {
  location.hash = '#/' + path.replace(/^\/+/, '');
}
