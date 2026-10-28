import { useEffect, useState } from 'react';
import { api, type Me } from './api';
import { go, href, useRoute, type Route } from './route';
import { ToastProvider } from './components/ui';
import { LoginPage } from './pages/LoginPage';
import { WorkPage } from './pages/WorkPage';
import { DashboardPage } from './pages/DashboardPage';
import { ClientsPage } from './pages/ClientsPage';
import { ClientPage } from './pages/ClientPage';
import { SurveysPage } from './pages/SurveysPage';
import { SurveyEditorPage } from './pages/SurveyEditorPage';
import { UsersPage } from './pages/UsersPage';
import { RolesPage } from './pages/RolesPage';
import { SettingsPage } from './pages/SettingsPage';
import { AuditPage } from './pages/AuditPage';

/** Пункты меню и права, с которыми они видны */
const NAV: { route: Route; label: string; any: string[]; sep?: boolean }[] = [
  { route: { page: 'work' }, label: 'Рабочий стол', any: ['queue.work'] },
  { route: { page: 'dashboard' }, label: 'Дашборд', any: ['reports.all', 'reports.own'] },
  { route: { page: 'clients' }, label: 'Клиенты и анкеты', any: ['responses.all', 'responses.own'] },
  { route: { page: 'surveys' }, label: 'Конструктор анкет', any: ['surveys.view', 'surveys.edit'], sep: true },
  { route: { page: 'users' }, label: 'Сотрудники', any: ['users.manage'] },
  { route: { page: 'roles' }, label: 'Роли и права', any: ['roles.manage'] },
  { route: { page: 'settings' }, label: 'Настройки', any: ['integrations.manage'] },
  { route: { page: 'audit' }, label: 'Журнал действий', any: ['audit.view'] },
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const route = useRoute();

  const loadMe = () => api<Me>('/api/me').then(setMe).catch(() => setMe(null));
  useEffect(() => {
    void loadMe();
    const onLogout = () => setMe(null);
    window.addEventListener('okk:logout', onLogout);
    return () => window.removeEventListener('okk:logout', onLogout);
  }, []);

  if (me === undefined) return <div className="empty">Загружаю…</div>;
  if (me === null) return <ToastProvider><LoginPage onLogin={loadMe} /></ToastProvider>;

  const can = (...p: string[]) => p.some((x) => me.permissions.includes(x));
  const items = NAV.filter((n) => can(...n.any));
  const allowed = route && items.some((n) => n.route.page === route.page || (route.page === 'client' && n.route.page === 'clients') || (route.page === 'survey' && n.route.page === 'surveys'));
  if (!allowed && items[0]) {
    setTimeout(() => go(items[0].route));
    return null;
  }

  const logout = async () => {
    await api('/api/logout', { body: {} }).catch(() => undefined);
    setMe(null);
  };

  const active = route?.page === 'client' ? 'clients' : route?.page === 'survey' ? 'surveys' : route?.page;
  return (
    <ToastProvider>
      <div className="shell">
        <aside className="side">
          <div className="brand"><i>ОКК</i>Контроль качества</div>
          <nav className="nav" aria-label="Разделы">
            {items.map((n) => (
              <div key={n.route.page}>
                {n.sep && <div className="sep" />}
                <a href={href(n.route)} aria-current={active === n.route.page ? 'page' : undefined}>{n.label}</a>
              </div>
            ))}
          </nav>
          <div className="who">
            <b>{me.name}</b>
            <span className="muted">{me.roleName}</span>
            <button className="btn sm" onClick={logout} style={{ justifySelf: 'start', marginTop: 4 }}>Выйти</button>
          </div>
        </aside>
        <main className="main">
          {!items.length && <div className="alert">У вашей роли нет доступа ни к одному разделу. Обратитесь к администратору.</div>}
          {route?.page === 'work' && <WorkPage me={me} cardId={route.cardId} />}
          {route?.page === 'dashboard' && <DashboardPage me={me} />}
          {route?.page === 'clients' && <ClientsPage me={me} />}
          {route?.page === 'client' && <ClientPage me={me} id={route.id} />}
          {route?.page === 'surveys' && <SurveysPage me={me} />}
          {route?.page === 'survey' && <SurveyEditorPage me={me} id={route.id} />}
          {route?.page === 'users' && <UsersPage me={me} />}
          {route?.page === 'roles' && <RolesPage />}
          {route?.page === 'settings' && <SettingsPage />}
          {route?.page === 'audit' && <AuditPage />}
        </main>
      </div>
    </ToastProvider>
  );
}
