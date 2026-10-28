import { useEffect, useState } from 'react';

/** Экраны кабинета. Адрес — в hash: «назад» и «вперёд» работают без настройки сервера. */
export type Route =
  | { page: 'work'; cardId?: number }
  | { page: 'dashboard' }
  | { page: 'clients' }
  | { page: 'client'; id: number }
  | { page: 'surveys' }
  | { page: 'survey'; id: number }
  | { page: 'users' }
  | { page: 'roles' }
  | { page: 'settings' }
  | { page: 'audit' };

export function parseRoute(hash: string): Route | null {
  const [a, b] = hash.replace(/^#\/?/, '').split('/');
  const n = b && /^\d+$/.test(b) ? Number(b) : undefined;
  switch (a) {
    case 'work': return { page: 'work', cardId: n };
    case 'dashboard': return { page: 'dashboard' };
    case 'clients': return n ? { page: 'client', id: n } : { page: 'clients' };
    case 'surveys': return n ? { page: 'survey', id: n } : { page: 'surveys' };
    case 'users': return { page: 'users' };
    case 'roles': return { page: 'roles' };
    case 'settings': return { page: 'settings' };
    case 'audit': return { page: 'audit' };
    default: return null;
  }
}

export function href(r: Route): string {
  switch (r.page) {
    case 'work': return r.cardId ? `#/work/${r.cardId}` : '#/work';
    case 'client': return `#/clients/${r.id}`;
    case 'survey': return `#/surveys/${r.id}`;
    default: return `#/${r.page}`;
  }
}

export const go = (r: Route) => { window.location.hash = href(r); };

export function useRoute(): Route | null {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
