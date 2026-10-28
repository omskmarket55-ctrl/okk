import { useState } from 'react';
import { api, type Me } from '../api';
import { go } from '../route';
import { Loading, useLoad } from '../components/ui';
import { fmtDateTime, npsClass } from '../format';

interface Row { id: number; dealId: number; clientName: string; phone: string; status: string; statusLabel: string; repeat: boolean; callbackAt: string | null; updatedAt: string; attempts: number; nps: number | null }

const STATUSES = [['', 'Все'], ['queued', 'В очереди'], ['callback', 'Перезвон'], ['done', 'Анкета заполнена'], ['refused', 'Отказ'], ['closed', 'Сняты с обзвона']];
const statusPill = (s: string, repeat: boolean) => (s === 'done' ? 'good' : s === 'refused' || s === 'closed' ? '' : s === 'callback' || repeat ? 'warn' : 'acc');

export function ClientsPage({ me }: { me: Me }) {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const { data, error } = useLoad(
    () => api<{ total: number; items: Row[] }>(`/api/cards?status=${status}&search=${encodeURIComponent(query)}&page=${page}`),
    [status, query, page],
  );
  const pages = data ? Math.max(1, Math.ceil(data.total / 50)) : 1;
  return (
    <>
      <div className="page-h">
        <div><div className="label">{me.permissions.includes('responses.all') ? 'Все клиенты' : 'Мои клиенты'}</div><h1>Клиенты и анкеты</h1></div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(search); }}>
          <input placeholder="ФИО или номер сделки" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
          <select aria-label="Статус" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }} style={{ width: 'auto' }}>
            {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button className="btn">Найти</button>
        </form>
      </div>
      <section className="panel">
        {!data ? <Loading error={error} /> : (
          <div className="tbl"><table>
            <thead><tr><th>Клиент</th><th>Телефон</th><th>Сделка</th><th>Статус</th><th className="num">NPS</th><th className="num">Попыток</th><th>Обновлено</th></tr></thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id} className="click" onClick={() => go({ page: 'client', id: r.id })}>
                  <td><b>{r.clientName}</b></td>
                  <td className="mono">{r.phone}</td>
                  <td className="mono">#{r.dealId}</td>
                  <td><span className={`pill ${statusPill(r.status, r.repeat)}`}>{r.statusLabel}</span>{r.status === 'callback' && r.callbackAt && <div className="muted small">{fmtDateTime(r.callbackAt)}</div>}</td>
                  <td className="num">{r.nps != null ? <span className={`pill ${npsClass(r.nps)}`}>{r.nps}</span> : '—'}</td>
                  <td className="num">{r.attempts}</td>
                  <td className="mono small">{fmtDateTime(r.updatedAt)}</td>
                </tr>
              ))}
              {!data.items.length && <tr><td colSpan={7} className="muted">Никого не нашлось</td></tr>}
            </tbody>
          </table></div>
        )}
        {data && pages > 1 && (
          <div className="foot">
            <span className="muted small">Всего: {data.total}</span>
            <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Назад</button>
            <span className="mono small">{page} / {pages}</span>
            <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Дальше</button>
          </div>
        )}
      </section>
    </>
  );
}
