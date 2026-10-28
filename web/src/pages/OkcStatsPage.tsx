import { useState } from 'react';
import { api, type Me } from '../api';
import { Loading, useLoad } from '../components/ui';
import { isoDay } from '../format';

interface Row { userId: number | null; name: string; calls: number; dialed: number; meetings: number; done: number; failed: number; refused: number; breakSeconds: number; toMeeting: number | null; doneOfMeetings: number | null; doneOfDialed: number | null }
interface Stats { total: Row; operators: Row[]; daily: { day: string; calls: number; meetings: number; done: number }[]; base: Record<string, number> }

const pct = (n: number | null) => (n == null ? '—' : `${n.toLocaleString('ru-RU')}%`);
const hm = (s: number) => `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`;

function period(kind: string): [string, string] {
  const t = new Date();
  const d = new Date(t);
  if (kind === 'week') d.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  if (kind === 'month') d.setDate(1);
  return [isoDay(d), isoDay(t)];
}

export function OkcStatsPage({ me }: { me: Me }) {
  const all = me.permissions.includes('okc.stats.all');
  const [kind, setKind] = useState('day');
  const [[from, to], setRange] = useState(period('day'));
  const [userId, setUserId] = useState('');
  const ops = useLoad(() => (all ? api<{ items: { id: number; name: string }[] }>('/api/okc/operators') : Promise.resolve({ items: [] })), [all]);
  const { data, error } = useLoad(() => api<Stats>(`/api/okc/stats?from=${from}&to=${to}${userId ? `&userId=${userId}` : ''}`), [from, to, userId]);
  const pick = (k: string) => { setKind(k); if (k !== 'custom') setRange(period(k)); };
  return (
    <>
      <div className="page-h">
        <div><div className="label">ОКЦ</div><h1>{all ? 'Статистика обзвона' : 'Моя статистика'}</h1></div>
        <div className="row">
          <div className="chips">{[['day', 'Сегодня'], ['week', 'Неделя'], ['month', 'Месяц'], ['custom', 'Период']].map(([k, l]) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => pick(k)}>{l}</button>)}</div>
          {kind === 'custom' && <>
            <input type="date" aria-label="С" value={from} onChange={(e) => setRange([e.target.value, to])} style={{ width: 'auto' }} />
            <input type="date" aria-label="По" value={to} onChange={(e) => setRange([from, e.target.value])} style={{ width: 'auto' }} />
          </>}
          {all && <select aria-label="Оператор" value={userId} onChange={(e) => setUserId(e.target.value)} style={{ width: 'auto' }}>
            <option value="">Все операторы</option>{ops.data?.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>}
        </div>
      </div>
      {!data ? <Loading error={error} /> : <>
        <div className="kpis">
          <div className="panel kpi"><div className="label">Звонков</div><div className="v">{data.total.calls}</div><div className="d">обзвонено карточек: {data.total.dialed}</div></div>
          <div className="panel kpi"><div className="label">Назначено встреч</div><div className="v">{data.total.meetings}</div><div className="d">конверсия {pct(data.total.toMeeting)}</div></div>
          <div className="panel kpi"><div className="label">Состоялось</div><div className="v">{data.total.done}</div><div className="d">из назначенных {pct(data.total.doneOfMeetings)}</div></div>
          <div className="panel kpi"><div className="label">Не состоялось</div><div className="v">{data.total.failed}</div></div>
          <div className="panel kpi"><div className="label">В состоявшуюся</div><div className="v">{pct(data.total.doneOfDialed)}</div><div className="d">от обзвоненных</div></div>
          <div className="panel kpi"><div className="label">Отказов</div><div className="v">{data.total.refused}</div><div className="d">перерывы: {hm(data.total.breakSeconds)}</div></div>
        </div>
        <div className="dash">
          {all && Object.keys(data.base).length > 0 && (
            <section className="panel c12">
              <div className="panel-h"><span className="label">База обзвона сейчас</span></div>
              <div className="panel-b row">
                {[['new', 'В базе'], ['later', 'Позвонить позднее'], ['agreement', 'Договорённость'], ['meeting', 'Встреча назначена'], ['meeting_done', 'Состоялась'], ['meeting_failed', 'Не состоялась'], ['refused', 'Отказ']].map(([k, l]) => (
                  <span key={k} className="pill">{l}: <b className="mono">{data.base[k] ?? 0}</b></span>
                ))}
              </div>
            </section>
          )}
          <section className="panel c12">
            <div className="panel-h"><span className="label">Операторы</span></div>
            <div className="tbl"><table>
              <thead><tr><th>Оператор</th><th className="num">Звонков</th><th className="num">Обзвонено</th><th className="num">Встреч</th><th className="num">Состоялось</th><th className="num">Не состоялось</th><th className="num">Отказов</th><th className="num">→ встреча</th><th className="num">Состоялась из назнач.</th><th className="num">Состоялась от обзвон.</th><th className="num">Перерывы</th></tr></thead>
              <tbody>
                {data.operators.map((o) => (
                  <tr key={o.userId}><td>{o.name}</td><td className="num">{o.calls}</td><td className="num">{o.dialed}</td><td className="num">{o.meetings}</td><td className="num">{o.done}</td><td className="num">{o.failed}</td><td className="num">{o.refused}</td><td className="num">{pct(o.toMeeting)}</td><td className="num">{pct(o.doneOfMeetings)}</td><td className="num">{pct(o.doneOfDialed)}</td><td className="num">{hm(o.breakSeconds)}</td></tr>
                ))}
                {!data.operators.length && <tr><td colSpan={11} className="muted">За период нет данных</td></tr>}
              </tbody>
            </table></div>
          </section>
          {data.daily.length > 1 && (
            <section className="panel c12">
              <div className="panel-h"><span className="label">По дням</span></div>
              <div className="tbl"><table>
                <thead><tr><th>День</th><th className="num">Звонков</th><th className="num">Назначено встреч</th><th className="num">Состоялось</th></tr></thead>
                <tbody>{data.daily.map((d) => <tr key={d.day}><td className="mono">{d.day.split('-').reverse().join('.')}</td><td className="num">{d.calls}</td><td className="num">{d.meetings}</td><td className="num">{d.done}</td></tr>)}</tbody>
              </table></div>
            </section>
          )}
        </div>
      </>}
    </>
  );
}
