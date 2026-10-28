import { useState } from 'react';
import { api } from '../api';
import { Loading, useLoad } from '../components/ui';
import { fmtDateTime } from '../format';

const ACTIONS: Record<string, string> = {
  login: 'Вход', login_failed: 'Неудачный вход', phone_view: 'Просмотр номера', export: 'Выгрузка в Excel',
  user_create: 'Новый сотрудник', user_update: 'Изменение сотрудника', role_create: 'Новая роль', role_update: 'Изменение прав роли', role_delete: 'Удаление роли',
  settings_update: 'Изменение настроек', survey_create: 'Новая анкета', survey_save: 'Правка анкеты', survey_publish: 'Публикация анкеты',
};

export function AuditPage() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const { data, error } = useLoad(() => api<{ items: { id: number; action: string; target: string | null; data: object; ip: string | null; createdAt: string; userName: string | null }[] }>(`/api/audit?page=${page}&action=${action}`), [page, action]);
  return (
    <>
      <div className="page-h">
        <div><div className="label">Безопасность</div><h1>Журнал действий</h1></div>
        <select aria-label="Действие" value={action} onChange={(e) => { setPage(1); setAction(e.target.value); }} style={{ width: 'auto' }}>
          <option value="">Все действия</option>
          {Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <section className="panel">
        {!data ? <Loading error={error} /> : (
          <div className="tbl"><table>
            <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Объект</th><th>IP</th></tr></thead>
            <tbody>{data.items.map((a) => (
              <tr key={a.id}>
                <td className="mono small">{fmtDateTime(a.createdAt)}</td><td>{a.userName ?? '—'}</td><td>{ACTIONS[a.action] ?? a.action}</td>
                <td className="mono small">{a.target?.startsWith('card:') ? <a href={`#/clients/${a.target.slice(5)}`}>{a.target}</a> : a.target ?? '—'}</td>
                <td className="mono small">{a.ip ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <div className="foot">
          <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Новее</button>
          <span className="mono small">стр. {page}</span>
          <button className="btn sm" disabled={!data || data.items.length < 100} onClick={() => setPage(page + 1)}>Старше</button>
        </div>
      </section>
    </>
  );
}
