import { useState } from 'react';
import { api, errorText } from '../api';
import { Field, Loading, Modal, useLoad, useToast } from '../components/ui';
import { fmtDateTime } from '../format';

interface W { id: number; amount: number; status: string; comment: string | null; createdAt: string; decidedAt: string | null; userId: number; userName: string; decidedBy: string | null }
const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;
const W_STATUS: Record<string, [string, string]> = { pending: ['Ждёт решения', 'warn'], approved: ['Одобрено', 'good'], rejected: ['Отклонено', 'bad'] };

export function PayoutsPage({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api<{ items: W[]; balances: Record<string, { accrued: number; available: number }> }>('/api/okc/withdrawals'), []);
  const prices = useLoad(() => api<{ office: number; dks: number }>('/api/okc/prices'), []);
  const [reject, setReject] = useState<W | null>(null);
  const [comment, setComment] = useState('');
  const [office, setOffice] = useState('');
  const [dks, setDks] = useState('');

  const decide = async (w: W, approve: boolean, text = '') => {
    try {
      await api(`/api/okc/withdrawals/${w.id}`, { body: { approve, comment: text } });
      toast(approve ? 'Заявка одобрена — оператор увидит это в кабинете' : 'Заявка отклонена');
      setReject(null);
      setComment('');
      reload();
      onChanged();
    } catch (e) {
      toast(errorText(e), true);
    }
  };
  const savePrices = async () => {
    try {
      await api('/api/okc/prices', { method: 'PUT', body: { office: Number(office || prices.data?.office), dks: Number(dks || prices.data?.dks) } });
      toast('Стоимость встреч сохранена. Она применяется к встречам, которые состоятся с этого момента');
      prices.reload();
    } catch (e) {
      toast(errorText(e), true);
    }
  };

  return (
    <>
      <div className="page-h"><div><div className="label">ОКЦ</div><h1>Бонусы и выплаты</h1></div></div>
      <div className="dash">
        <section className="panel c4">
          <div className="panel-h"><span className="label">Стоимость состоявшейся встречи</span></div>
          <div className="panel-b stack">
            <Field label="Офисная, ₽"><input className="mono" inputMode="numeric" placeholder={String(prices.data?.office ?? '')} value={office} onChange={(e) => setOffice(e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="ДКС (дистанционная), ₽"><input className="mono" inputMode="numeric" placeholder={String(prices.data?.dks ?? '')} value={dks} onChange={(e) => setDks(e.target.value.replace(/\D/g, ''))} /></Field>
            <p className="muted small" style={{ margin: 0 }}>Сейчас: офисная {rub(prices.data?.office ?? 0)}, ДКС {rub(prices.data?.dks ?? 0)}</p>
          </div>
          <div className="foot"><button className="btn primary" disabled={!office && !dks} onClick={savePrices}>Сохранить</button></div>
        </section>
        <section className="panel c8">
          <div className="panel-h"><span className="label">Заявки на вывод</span></div>
          {!data ? <Loading error={error} /> : (
            <div className="tbl"><table>
              <thead><tr><th>Дата</th><th>Оператор</th><th className="num">Сумма</th><th className="num">Начислено всего</th><th>Статус</th><th /></tr></thead>
              <tbody>
                {data.items.map((w) => (
                  <tr key={w.id}>
                    <td className="mono small">{fmtDateTime(w.createdAt)}</td><td>{w.userName}</td><td className="num"><b>{rub(w.amount)}</b></td>
                    <td className="num">{rub(data.balances[w.userId]?.accrued ?? 0)}</td>
                    <td><span className={`pill ${W_STATUS[w.status][1]}`}>{W_STATUS[w.status][0]}</span>{w.decidedBy && <div className="small muted">{w.decidedBy}, {fmtDateTime(w.decidedAt)}</div>}{w.comment && <div className="small">{w.comment}</div>}</td>
                    <td>{w.status === 'pending' && <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn sm primary" onClick={() => decide(w, true)}>Одобрить</button>
                      <button className="btn sm" onClick={() => setReject(w)}>Отклонить</button>
                    </div>}</td>
                  </tr>
                ))}
                {!data.items.length && <tr><td colSpan={6} className="muted">Заявок пока нет</td></tr>}
              </tbody>
            </table></div>
          )}
        </section>
      </div>
      {reject && (
        <Modal title={`Отклонить заявку на ${rub(reject.amount)}?`} onClose={() => setReject(null)} footer={<><button className="btn" onClick={() => setReject(null)}>Отмена</button><button className="btn danger" disabled={!comment.trim()} onClick={() => decide(reject, false, comment)}>Отклонить</button></>}>
          <Field label="Причина — её увидит оператор"><textarea value={comment} onChange={(e) => setComment(e.target.value)} autoFocus /></Field>
          <p className="muted small" style={{ margin: 0 }}>Сумма вернётся в доступный баланс оператора.</p>
        </Modal>
      )}
    </>
  );
}
