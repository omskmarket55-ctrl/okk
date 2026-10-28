import { useState } from 'react';
import { api, errorText } from '../api';
import { Field, Loading, Modal, useLoad, useToast } from '../components/ui';
import { fmtDate, fmtDateTime } from '../format';

interface Bonus {
  summary: { accrued: number; withdrawn: number; pending: number; available: number };
  accruals: { id: number; amount: number; meetingType: string; createdAt: string; cardId: number; clientName: string | null; meetingAt: string }[];
  withdrawals: { id: number; amount: number; status: string; comment: string | null; createdAt: string; decidedAt: string | null }[];
  prices: { office: number; dks: number };
}

const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;
const W_STATUS: Record<string, [string, string]> = { pending: ['На проверке', 'warn'], approved: ['Одобрено', 'good'], rejected: ['Отклонено', 'bad'] };

export function BonusPage() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api<Bonus>('/api/okc/bonus'), []);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  if (!data) return <Loading error={error} />;
  const s = data.summary;
  const request = async () => {
    setBusy(true);
    try {
      await api('/api/okc/bonus/withdraw', { body: { amount: Number(amount.replace(',', '.')) } });
      setOpen(false);
      toast('Заявка на вывод отправлена администратору');
      reload();
    } catch (e) {
      toast(errorText(e), true);
    }
    setBusy(false);
  };
  return (
    <>
      <div className="page-h">
        <div><div className="label">ОКЦ</div><h1>Мой бонус</h1></div>
        <button className="btn primary" disabled={s.available <= 0} onClick={() => { setAmount(String(s.available)); setOpen(true); }}>Вывести бонус</button>
      </div>
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        <div className="panel kpi"><div className="label">Доступно к выводу</div><div className="v">{rub(s.available)}</div></div>
        <div className="panel kpi"><div className="label">На проверке</div><div className="v">{rub(s.pending)}</div></div>
        <div className="panel kpi"><div className="label">Выплачено</div><div className="v">{rub(s.withdrawn)}</div></div>
        <div className="panel kpi"><div className="label">Начислено всего</div><div className="v">{rub(s.accrued)}</div><div className="d">офисная {rub(data.prices.office)} · ДКС {rub(data.prices.dks)}</div></div>
      </div>
      <div className="dash">
        <section className="panel c6">
          <div className="panel-h"><span className="label">Заявки на вывод</span></div>
          <div className="tbl"><table>
            <thead><tr><th>Дата</th><th className="num">Сумма</th><th>Статус</th></tr></thead>
            <tbody>
              {data.withdrawals.map((w) => (
                <tr key={w.id}>
                  <td className="mono small">{fmtDateTime(w.createdAt)}</td><td className="num">{rub(w.amount)}</td>
                  <td><span className={`pill ${W_STATUS[w.status][1]}`}>{W_STATUS[w.status][0]}</span>
                    {w.status === 'approved' && <div className="small muted">Перечисление в течение 3 рабочих дней</div>}
                    {w.status === 'rejected' && w.comment && <div className="small err">{w.comment}</div>}</td>
                </tr>
              ))}
              {!data.withdrawals.length && <tr><td colSpan={3} className="muted">Заявок пока не было</td></tr>}
            </tbody>
          </table></div>
        </section>
        <section className="panel c6">
          <div className="panel-h"><span className="label">Начисления за состоявшиеся встречи</span></div>
          <div className="tbl"><table>
            <thead><tr><th>Встреча</th><th>Клиент</th><th>Тип</th><th className="num">Бонус</th></tr></thead>
            <tbody>
              {data.accruals.map((a) => <tr key={a.id}><td className="mono small">{fmtDate(a.meetingAt)}</td><td><a href={`#/okc/${a.cardId}`}>{a.clientName ?? '—'}</a></td><td>{a.meetingType === 'office' ? 'Офисная' : 'ДКС'}</td><td className="num">{rub(a.amount)}</td></tr>)}
              {!data.accruals.length && <tr><td colSpan={4} className="muted">Бонус начисляется, когда в Битрикс24 сделку переводят в стадию «Встреча состоялась»</td></tr>}
            </tbody>
          </table></div>
        </section>
      </div>
      {open && (
        <Modal title="Вывод бонуса" onClose={() => setOpen(false)} footer={<><button className="btn" onClick={() => setOpen(false)}>Отмена</button><button className="btn primary" disabled={busy || !(Number(amount.replace(',', '.')) > 0)} onClick={request}>Запросить вывод</button></>}>
          <div className="chips"><button type="button" onClick={() => setAmount(String(s.available))}>Всю сумму · {rub(s.available)}</button></div>
          <Field label="Сумма, ₽"><input inputMode="decimal" className="mono" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))} /></Field>
          <p className="muted small" style={{ margin: 0 }}>Заявку проверит администратор. После одобрения деньги перечисляются в течение 3 рабочих дней.</p>
        </Modal>
      )}
    </>
  );
}
