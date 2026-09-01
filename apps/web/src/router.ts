import { useEffect, useState } from 'react';

/**
 * A router in thirty lines, because this app has five routes and one of them
 * is reached by pointing a phone camera at a windscreen.
 *
 * Real paths rather than hashes: `/s/ABCD-EFGH-JK` is what gets printed on a
 * sticker, and a hash would survive neither a QR scanner's preview nor a
 * pasted link cleanly.
 */
export type Route =
  | { name: 'home' }
  | { name: 'sticker'; code: string }
  | { name: 'plate' }
  | { name: 'sent' }
  | { name: 'signin' }
  | { name: 'mine' }
  | { name: 'demo' };

export function parseRoute(pathname: string): Route {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/');
  const [first, second] = segments;

  if (!first) return { name: 'home' };
  if (first === 's' && second) return { name: 'sticker', code: decodeURIComponent(second) };
  if (first === 'plate') return { name: 'plate' };
  if (first === 'sent') return { name: 'sent' };
  if (first === 'signin') return { name: 'signin' };
  if (first === 'me') return { name: 'mine' };
  if (first === 'demo') return { name: 'demo' };
  return { name: 'home' };
}

export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);

  return route;
}
