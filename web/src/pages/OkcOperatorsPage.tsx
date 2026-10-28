import { useEffect, useState } from 'react';
import { api, errorText, type Me } from '../api';
import { Loading, Modal, useLoad, useToast } from '../components/ui';
import { fmtDateTime } from '../format';

interface Op { id: number; name: string; active: boolean; lastSeenAt: string | null; status: string; since: string | null; currentCardId: number | null; pinned: number; meetings: number }
const ST: Record<string, [string, string]> = { ready: ['Готов', 'good'], break: ['Перерыв', 'warn'], offline: ['Не готов', ''] };
const dur = (since: string | null, now: number) => {
  if (!since) return '';
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
};

export function OkcOperatorsPage({ me }: { me: Me }) {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api<{ items: Op[] }>('/api/okc/operators'), []);
  const [now, setNow] = useState(Date.now());
  const [confirm, setConfirm] = useState<Op | null>(null);
  useEffect(() => {
    const t = setInterval(() => { setNow(Date.now()); reload(); }, 30_000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const release = async (op: Op) => {
    setConfirm(null);
    try {
      const r = await api<{ released: number }>(`/api/okc/operators/${op.id}/release`, { body: {} });
      toast(`Снято карточек: ${r.released}. Они вернулись в общую базу`);
      reload();
    } catch (e) {
      toast(errorText(e), true);
    }
  };
  return (
    <>
      <div className="page-h"><div><div className="label">ОКЦ</div><h1>Операторы</h1></div></div>
      <section className="panel">
        {!data ? <Loading error={error} /> : (
          <div className="tbl"><table>
            <thead><tr><th>Оператор</th><th>Статус</th><th>Сейчас на экране</th><th className="num">Закреплено</th><th className="num">Встреч</th><th>Был в кабинете</th><th /></tr></thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id} style={o.active ? undefined : { opacity: 0.55 }}>
                  <td><b>{o.name}</b>{!o.active && <span className="pill" style={{ marginLeft: 6 }}>заблокирован</span>}</td>
                  <td><span className={`pill ${ST[o.status]?.[1] ?? ''}`}>{ST[o.status]?.[0] ?? o.status}</span> <span className="mono small muted">{o.status !== 'offline' ? dur(o.since, now) : ''}</span></td>
                  <td>{o.currentCardId ? <a href={`#/okc/${o.currentCardId}`}>Карточка #{o.currentCardId}</a> : '—'}</td>
                  <td className="num">{o.pinned}</td><td className="num">{o.meetings}</td>
                  <td className="mono small">{fmtDateTime(o.lastSeenAt)}</td>
                  <td>{me.permissions.includes('okc.reassign') && o.pinned + (o.currentCardId ? 1 : 0) > 0 && <button className="btn sm" onClick={() => setConfirm(o)}>Снять карточки</button>}</td>
                </tr>
              ))}
              {!data.items.length && <tr><td colSpan={7} className="muted">Нет сотрудников с ролью оператора ОКЦ. Назначьте её в разделе «Сотрудники».</td></tr>}
            </tbody>
          </table></div>
        )}
      </section>
      <p className="muted small">Встречи остаются за оператором: за состоявшуюся встречу ему начисляется бонус. Снимаются карточки в обзвоне: «позвонить позднее», договорённости, несостоявшиеся встречи.</p>
      {confirm && (
        <Modal title={`Снять карточки с оператора ${confirm.name}?`} onClose={() => setConfirm(null)} footer={<><button className="btn" onClick={() => setConfirm(null)}>Отмена</button><button className="btn danger" onClick={() => release(confirm)}>Снять и вернуть в базу</button></>}>
          <p style={{ margin: 0 }}>Закреплённые карточки ({confirm.pinned}) уйдут в общую базу и распределятся на других операторов. История и комментарии сохранятся.</p>
        </Modal>
      )}
    </>
  );
}
