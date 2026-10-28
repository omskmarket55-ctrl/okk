import { useState } from 'react';
import { api, type Me } from '../api';
import { go } from '../route';
import { Loading, useLoad } from '../components/ui';
import { fmtDate, fmtSeconds, isoDay, npsClass } from '../format';

interface Dashboard {
  kpis: {
    nps: number | null; responses: number; promoters: number; passives: number; detractors: number; refused: number;
    callbacksPending: number; queued: number; imported: number; calls: number; answeredCalls: number; avgTalkSeconds: number | null;
    referrals: number; leadsSent: number; leadErrors: number;
  };
  distribution: number[];
  weekly: { week: string; nps: number | null; count: number }[];
  operators: { userId: number; name: string; responses: number; nps: number | null; referrals: number }[];
  breakdown: { title: string; options: { label: string; total: number; promoter: number; passive: number; detractor: number }[] }[];
  detractors: { cardId: number; clientName: string; nps: number; comment: string; userName: string | null; at: string }[];
}

const signed = (n: number | null) => (n == null ? '—' : n > 0 ? `+${n}` : String(n));
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

export function DashboardPage({ me }: { me: Me }) {
  const today = new Date();
  const [from, setFrom] = useState(isoDay(new Date(today.getTime() - 29 * 86_400_000)));
  const [to, setTo] = useState(isoDay(today));
  const [userId, setUserId] = useState('');
  const all = me.permissions.includes('reports.all');
  const users = useLoad(() => (all ? api<{ items: { id: number; name: string }[] }>('/api/users') : Promise.resolve({ items: [] })), [all]);
  const { data, error } = useLoad(() => api<Dashboard>(`/api/dashboard?from=${from}&to=${to}${userId ? `&userId=${userId}` : ''}`), [from, to, userId]);

  return (
    <>
      <div className="page-h">
        <div><div className="label">Контроль качества</div><h1>{all ? 'Дашборд NPS' : 'Моя статистика'}</h1></div>
        <div className="row">
          <input type="date" aria-label="С" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} />
          <span className="muted">—</span>
          <input type="date" aria-label="По" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} />
          {all && (
            <select aria-label="Сотрудник" value={userId} onChange={(e) => setUserId(e.target.value)} style={{ width: 'auto' }}>
              <option value="">Все сотрудники</option>
              {users.data?.items.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
          {me.permissions.includes('reports.export') && <a className="btn" href={`/api/reports/responses.csv?from=${from}&to=${to}`}>Выгрузить в Excel</a>}
        </div>
      </div>
      {!data ? <Loading error={error} /> : <DashboardBody d={data} />}
    </>
  );
}

function DashboardBody({ d }: { d: Dashboard }) {
  const k = d.kpis;
  const total = k.promoters + k.passives + k.detractors;
  return (
    <>
      <div className="kpis">
        <div className="panel kpi"><div className="label">NPS</div><div className="v">{signed(k.nps)}</div><div className="d">{k.responses} анкет с оценкой</div></div>
        <div className="panel kpi"><div className="label">В очереди</div><div className="v">{k.queued}</div><div className="d">ждут перезвона: {k.callbacksPending}</div></div>
        <div className="panel kpi"><div className="label">Звонков</div><div className="v">{k.calls}</div><div className="d">дозвон {pct(k.answeredCalls, k.calls)} · ср. {fmtSeconds(k.avgTalkSeconds)}</div></div>
        <div className="panel kpi"><div className="label">Рекомендаций</div><div className="v">{k.referrals}</div><div className="d">{pct(k.referrals, k.responses)} анкет</div></div>
        <div className="panel kpi"><div className="label">Лидов создано</div><div className="v">{k.leadsSent}</div><div className="d" style={k.leadErrors ? { color: 'var(--bad)' } : undefined}>{k.leadErrors ? `ошибок: ${k.leadErrors}` : 'без ошибок'}</div></div>
        <div className="panel kpi"><div className="label">Отказов</div><div className="v">{k.refused}</div><div className="d">новых клиентов: {k.imported}</div></div>
      </div>

      <div className="dash">
        <section className="panel c8 chart">
          <div className="panel-h"><span className="label">NPS по неделям</span><div className="legend"><span><i style={{ background: 'var(--accent)' }} />NPS</span><span><i style={{ background: 'var(--line)' }} />число анкет</span></div></div>
          <div className="panel-b">{d.weekly.length ? <Trend weekly={d.weekly} /> : <div className="empty">Нет анкет за период</div>}</div>
        </section>
        <section className="panel c4">
          <div className="panel-h"><span className="label">Структура оценок</span></div>
          <div className="panel-b">
            <div className="split">
              <span style={{ width: pct(k.promoters, total), background: 'var(--good)' }} />
              <span style={{ width: pct(k.passives, total), background: 'var(--warn)' }} />
              <span style={{ width: pct(k.detractors, total), background: 'var(--bad)' }} />
            </div>
            <div className="legend" style={{ marginBottom: 14 }}>
              <span><i style={{ background: 'var(--good)' }} />Промоутеры 9–10 · {pct(k.promoters, total)}</span>
              <span><i style={{ background: 'var(--warn)' }} />Нейтралы 7–8 · {pct(k.passives, total)}</span>
              <span><i style={{ background: 'var(--bad)' }} />Критики 0–6 · {pct(k.detractors, total)}</span>
            </div>
            <Distribution values={d.distribution} />
          </div>
        </section>

        {d.breakdown.map((q) => (
          <section key={q.title} className="panel c6">
            <div className="panel-h"><span className="label">{q.title}</span></div>
            <div className="panel-b bars">
              {q.options.map((o) => {
                const max = Math.max(...q.options.map((x) => x.total));
                return (
                  <div key={o.label} className="b">
                    <span>{o.label}</span>
                    <div className="t" title={`Промоутеры ${o.promoter} · нейтралы ${o.passive} · критики ${o.detractor}`} style={{ width: `${(o.total / max) * 100}%` }}>
                      <span style={{ flex: o.promoter, background: 'var(--good)' }} />
                      <span style={{ flex: o.passive, background: 'var(--warn)' }} />
                      <span style={{ flex: o.detractor, background: 'var(--bad)' }} />
                    </div>
                    <span className="num">{o.total}</span>
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        <section className="panel c12">
          <div className="panel-h"><span className="label">Сотрудники</span></div>
          <div className="tbl"><table>
            <thead><tr><th>Сотрудник</th><th className="num">Анкет</th><th className="num">NPS</th><th className="num">Рекомендаций</th></tr></thead>
            <tbody>
              {d.operators.map((o) => <tr key={o.userId}><td>{o.name}</td><td className="num">{o.responses}</td><td className="num">{signed(o.nps)}</td><td className="num">{o.referrals}</td></tr>)}
              {!d.operators.length && <tr><td colSpan={4} className="muted">Нет данных за период</td></tr>}
            </tbody>
          </table></div>
        </section>

        <section className="panel c12">
          <div className="panel-h"><span className="label">Критики: оценка 0–6</span><span className="pill bad">{d.detractors.length}</span></div>
          <div className="tbl"><table>
            <thead><tr><th>Дата</th><th>Клиент</th><th className="num">Оценка</th><th>Комментарий</th><th>Сотрудник</th></tr></thead>
            <tbody>
              {d.detractors.map((r) => (
                <tr key={r.cardId} className="click" onClick={() => go({ page: 'client', id: r.cardId })}>
                  <td className="mono">{fmtDate(r.at)}</td><td>{r.clientName}</td>
                  <td className="num"><span className={`pill ${npsClass(r.nps)}`}>{r.nps}</span></td>
                  <td style={{ whiteSpace: 'normal', minWidth: 240 }}>{r.comment || <span className="muted">—</span>}</td><td>{r.userName ?? '—'}</td>
                </tr>
              ))}
              {!d.detractors.length && <tr><td colSpan={5} className="muted">Критиков за период нет</td></tr>}
            </tbody>
          </table></div>
        </section>
      </div>
    </>
  );
}

/** NPS по неделям: линия по шкале −100…+100 и столбики числа анкет. */
function Trend({ weekly }: { weekly: Dashboard['weekly'] }) {
  const W = 720, H = 240, L = 44, R = 14, T = 16, B = 30;
  const iw = W - L - R, ih = H - T - B;
  const vals = weekly.map((w) => w.nps ?? 0);
  const lo = Math.max(-100, Math.floor((Math.min(...vals, 0) - 10) / 20) * 20);
  const hi = Math.min(100, Math.ceil((Math.max(...vals, 0) + 10) / 20) * 20);
  const maxN = Math.max(...weekly.map((w) => w.count), 1);
  const x = (i: number) => L + (weekly.length === 1 ? iw / 2 : (i * iw) / (weekly.length - 1));
  const y = (v: number) => T + ih - ((v - lo) / (hi - lo)) * ih;
  const ticks: number[] = [];
  for (let t = lo; t <= hi; t += 20) ticks.push(t);
  const pts = weekly.map((w, i) => `${x(i)},${y(w.nps ?? 0)}`).join(' ');
  const last = weekly.length - 1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="NPS по неделям">
      {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--line)" /><text x={L - 8} y={y(t) + 4} textAnchor="end">{t > 0 ? `+${t}` : t}</text></g>)}
      {weekly.map((w, i) => { const h = (w.count / maxN) * ih * 0.6; return <rect key={w.week} x={x(i) - 10} y={T + ih - h} width={20} height={h} rx={3} fill="var(--line)" opacity={0.7} />; })}
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinejoin="round" />
      {weekly.map((w, i) => <circle key={w.week} cx={x(i)} cy={y(w.nps ?? 0)} r={i === last ? 5 : 3} fill={i === last ? 'var(--accent)' : 'var(--surface)'} stroke="var(--accent)" strokeWidth={2} />)}
      <text x={x(last)} y={y(vals[last]) - 12} textAnchor="middle" style={{ fill: 'var(--fg)', fontWeight: 600 }}>{signed(weekly[last].nps)}</text>
      {weekly.map((w, i) => <text key={w.week} x={x(i)} y={H - 10} textAnchor="middle">{w.week.slice(8, 10)}.{w.week.slice(5, 7)}</text>)}
    </svg>
  );
}

function Distribution({ values }: { values: number[] }) {
  const W = 300, H = 120, bw = W / 11, max = Math.max(...values, 1);
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label="Распределение оценок от 0 до 10">
        {values.map((c, i) => {
          const h = (c / max) * H;
          return <g key={i}><rect x={i * bw + 3} y={H - h} width={bw - 6} height={Math.max(h, 1)} rx={2} fill={i <= 6 ? 'var(--bad)' : i <= 8 ? 'var(--warn)' : 'var(--good)'} /><text x={i * bw + bw / 2} y={H + 14} textAnchor="middle">{i}</text></g>;
        })}
      </svg>
    </div>
  );
}
