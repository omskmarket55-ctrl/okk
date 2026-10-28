import { useState } from 'react';
import { api, errorText } from '../api';
import { go } from '../route';
import { Loading, useLoad, useToast } from '../components/ui';
import { fmtDateTime, toLocalInput } from '../format';

interface Item { id: number; clientName: string | null; phoneTail: string; status: string; statusLabel: string; callbackAt: string | null; availableAt: string; pinUntil: string | null; meetingAt: string | null; meetingType: string | null; meetingRegion: string | null; taskDueAt: string | null }
interface Task { id: number; dueAt: string; cardId: number; clientName: string | null; phoneTail: string; meetingAt: string; meetingType: string }

const TABS = [
  ['meeting', 'Назначена встреча'],
  ['agreement', 'Есть договорённость'],
  ['later', 'Позвонить позднее'],
  ['done', 'Встреча состоялась'],
] as const;
const REGION: Record<string, string> = { city: 'Город', region: 'Область', outside: 'Не Пермский край' };

export function OkcMyPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('meeting');
  const { data, error } = useLoad(() => api<{ items: Item[] }>(`/api/okc/my?section=${tab}`), [tab]);
  const tasks = useLoad(() => api<{ items: Task[] }>('/api/okc/tasks'), []);
  return (
    <>
      <div className="page-h"><div><div className="label">ОКЦ</div><h1>Мои карточки</h1></div></div>
      {tasks.data && tasks.data.items.length > 0 && <TasksBlock items={tasks.data.items} reload={tasks.reload} />}
      <div className="chips" style={{ marginBottom: 12 }}>
        {TABS.map(([k, l]) => <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <section className="panel">
        {!data ? <Loading error={error} /> : (
          <div className="tbl"><table>
            <thead><tr><th>Клиент</th><th>Телефон</th>{tab === 'meeting' || tab === 'done' ? <><th>Встреча</th><th>Тип</th><th>Где</th></> : <><th>{tab === 'agreement' ? 'Позвонить' : 'Снова в обзвоне'}</th><th>Закреплена до</th></>}<th>Статус</th></tr></thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id} className="click" onClick={() => go({ page: 'okcCard', id: c.id })}>
                  <td><b>{c.clientName ?? 'Без имени'}</b></td>
                  <td className="mono">••{c.phoneTail}</td>
                  {tab === 'meeting' || tab === 'done' ? <>
                    <td className="mono">{fmtDateTime(c.meetingAt)}</td>
                    <td>{c.meetingType === 'office' ? 'Офисная' : 'ДКС'}</td>
                    <td>{REGION[c.meetingRegion ?? ''] ?? '—'}</td>
                  </> : <>
                    <td className="mono">{fmtDateTime(tab === 'agreement' ? c.callbackAt : c.availableAt)}</td>
                    <td className="mono small">{fmtDateTime(c.pinUntil).slice(0, 10)}</td>
                  </>}
                  <td><span className="pill">{c.statusLabel}</span>{c.taskDueAt && <div className="small muted">дело {fmtDateTime(c.taskDueAt)}</div>}</td>
                </tr>
              ))}
              {!data.items.length && <tr><td colSpan={7} className="muted">Здесь пока пусто</td></tr>}
            </tbody>
          </table></div>
        )}
      </section>
    </>
  );
}

function TasksBlock({ items, reload }: { items: Task[]; reload: () => void }) {
  const toast = useToast();
  const [moving, setMoving] = useState<number | null>(null);
  const [value, setValue] = useState('');
  const save = async (id: number, body: object) => {
    try {
      await api(`/api/okc/tasks/${id}`, { method: 'PUT', body });
      setMoving(null);
      reload();
    } catch (e) {
      toast(errorText(e), true);
    }
  };
  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-h"><span className="label">Дела: напомнить о встрече</span><span className="pill acc">{items.length}</span></div>
      <div className="tbl"><table>
        <thead><tr><th>Когда напомнить</th><th>Клиент</th><th>Встреча</th><th /></tr></thead>
        <tbody>{items.map((t) => (
          <tr key={t.id}>
            <td><span className={`pill ${new Date(t.dueAt) <= new Date() ? 'bad' : 'warn'}`}>{fmtDateTime(t.dueAt)}</span></td>
            <td><a href={`#/okc/${t.cardId}`}>{t.clientName ?? 'Без имени'}</a> <span className="mono muted">••{t.phoneTail}</span></td>
            <td className="mono">{fmtDateTime(t.meetingAt)}</td>
            <td><div className="row" style={{ justifyContent: 'flex-end' }}>
              {moving === t.id ? <>
                <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 'auto' }} />
                <button className="btn sm primary" onClick={() => save(t.id, { dueAt: new Date(value).toISOString() })}>Перенести</button>
                <button className="btn sm ghost" onClick={() => setMoving(null)}>Отмена</button>
              </> : <>
                <button className="btn sm" onClick={() => { setMoving(t.id); setValue(toLocalInput(new Date(Date.now() + 3_600_000))); }}>Перенести</button>
                <button className="btn sm" onClick={() => save(t.id, { done: true })}>Выполнено</button>
              </>}
            </div></td>
          </tr>
        ))}</tbody>
      </table></div>
    </section>
  );
}
