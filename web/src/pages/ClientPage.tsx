import { useState } from 'react';
import { api, errorText, type Me } from '../api';
import { go } from '../route';
import { Loading, Modal, useLoad, useToast } from '../components/ui';
import { AnswersView } from '../components/SurveyForm';
import { CallbackDialog } from '../components/Dialogs';
import { eventText, fmtDateTime, fmtSeconds, npsClass } from '../format';
import { CALL_STATUS, type CardView } from '../types';

const OUTCOME: Record<string, string> = { done: 'Заполнена', callback: 'Перезвон', refused: 'Отказ' };

/** Полная карточка клиента: номер (по праву), ссылка на сделку, все анкеты, звонки, СМС и история. */
export function ClientPage({ me, id }: { me: Me; id: number }) {
  const toast = useToast();
  const { data: c, error, reload } = useLoad(() => api<CardView>(`/api/cards/${id}`), [id]);
  const users = useLoad(() => (me.permissions.includes('queue.assign') ? api<{ items: { id: number; name: string; active: boolean }[] }>('/api/users') : Promise.resolve({ items: [] })), []);
  const [dialog, setDialog] = useState<'callback' | 'close' | null>(null);
  const can = (p: string) => me.permissions.includes(p);

  const manage = async (body: object, text: string) => {
    try {
      await api(`/api/cards/${id}/manage`, { body });
      toast(text);
      reload();
    } catch (e) {
      toast(errorText(e), true);
    }
  };
  const resend = async (rid: number) => {
    const r = await api<{ ok: boolean; leadId?: number; error?: string }>(`/api/referrals/${rid}/resend`, { body: {} }).catch((e) => ({ ok: false, error: errorText(e) }));
    toast(r.ok ? `Лид #${'leadId' in r ? r.leadId : ''} создан` : `Не получилось: ${r.error}`, !r.ok);
    reload();
  };

  if (!c) return <Loading error={error} />;
  return (
    <>
      <div className="page-h">
        <div>
          <a href="#/clients" className="small">← Все клиенты</a>
          <h1 style={{ marginTop: 4 }}>{c.clientName}</h1>
        </div>
        <div className="row">
          {c.dealUrl && <a className="btn" href={c.dealUrl} target="_blank" rel="noreferrer">Сделка #{c.dealId} в Битрикс24 ↗</a>}
          {can('queue.work') && c.status === 'queued' && <button className="btn primary" onClick={() => go({ page: 'work', cardId: c.id })}>Открыть на рабочем столе</button>}
        </div>
      </div>

      <div className="dash">
        <section className="panel c8">
          <div className="panel-h"><span className="label">Клиент</span><span className="pill acc">{c.statusLabel}</span></div>
          <div className="panel-b">
            <div className="kv">
              <div><span>Телефон</span><span className="mono">{c.phone}{!c.phoneFull && c.hasPhone && <span className="muted small"> · полный номер скрыт</span>}</span></div>
              <div><span>Сделка</span><span>#{c.dealId}{c.dealTitle ? ` · ${c.dealTitle}` : ''}</span></div>
              {c.fields.map((f) => <div key={f.code}><span>{f.label}</span><span>{f.value}</span></div>)}
              <div><span>В обзвоне с</span><span>{fmtDateTime(c.createdAt)}</span></div>
              {c.callbackAt && <div><span>Перезвон</span><span>{fmtDateTime(c.callbackAt)}</span></div>}
              <div><span>Попыток звонка</span><span className="num">{c.attempts}</span></div>
              <div><span>Сотрудник</span><span>{c.assignedName ?? 'любой из очереди'}</span></div>
            </div>
          </div>
          {(can('queue.manage') || can('queue.assign')) && (
            <div className="foot">
              {can('queue.assign') && (
                <select aria-label="Назначить сотрудника" value={c.assignedUserId ?? ''} style={{ width: 'auto' }}
                  onChange={(e) => manage({ action: 'assign', userId: e.target.value ? Number(e.target.value) : null }, 'Назначение сохранено')}>
                  <option value="">Любой сотрудник</option>
                  {users.data?.items.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              )}
              <span className="grow" />
              {can('queue.manage') && <>
                <button className="btn" onClick={() => setDialog('callback')}>Назначить перезвон</button>
                {c.status !== 'queued' && <button className="btn" onClick={() => manage({ action: 'requeue' }, 'Клиент вернулся в очередь')}>Вернуть в очередь</button>}
                {c.status !== 'closed' && <button className="btn" onClick={() => setDialog('close')}>Снять с обзвона</button>}
              </>}
            </div>
          )}
        </section>

        <section className="panel c4">
          <div className="panel-h"><span className="label">История</span></div>
          <div className="panel-b" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <ul className="hist">{c.events.map((e) => <li key={e.id}><time>{fmtDateTime(e.createdAt)}{e.userName ? ` · ${e.userName}` : ''}</time>{eventText(e)}</li>)}</ul>
          </div>
        </section>

        <section className="panel c12">
          <div className="panel-h"><span className="label">Анкеты</span></div>
          {!c.responses.length ? <div className="empty">Анкета ещё не заполнялась</div> : c.responses.map((r) => (
            <div key={r.id} className="panel-b" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="row" style={{ marginBottom: 10 }}>
                <b>{r.surveyName}</b><span className="muted small">версия {r.version}</span>
                <span className="pill">{OUTCOME[r.outcome] ?? r.outcome}</span>
                {r.nps != null && <span className={`pill ${npsClass(r.nps)}`}>NPS {r.nps}</span>}
                <span className="grow" />
                <span className="muted small">{fmtDateTime(r.updatedAt)} · {r.userName ?? '—'}</span>
              </div>
              <AnswersView schema={r.schema} answers={r.answers} />
            </div>
          ))}
        </section>

        {c.referrals.length > 0 && (
          <section className="panel c12">
            <div className="panel-h"><span className="label">Рекомендации → лиды</span></div>
            <div className="tbl"><table>
              <thead><tr><th>Имя</th><th>Телефон</th><th>Комментарий</th><th>Лид в Битрикс24</th><th /></tr></thead>
              <tbody>{c.referrals.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td><td className="mono">{r.phone}</td><td>{r.comment || '—'}</td>
                  <td>{r.leadId ? (r.leadUrl ? <a href={r.leadUrl} target="_blank" rel="noreferrer">Лид #{r.leadId} ↗</a> : `Лид #${r.leadId}`) : <span className="pill bad" title={r.error ?? ''}>Не создан</span>}{r.error && !r.leadId && <div className="err">{r.error}</div>}</td>
                  <td>{!r.leadId && can('leads.resend') && <button className="btn sm" onClick={() => resend(r.id)}>Отправить ещё раз</button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </section>
        )}

        <section className="panel c6">
          <div className="panel-h"><span className="label">Звонки</span></div>
          <div className="tbl"><table>
            <thead><tr><th>Когда</th><th>Сотрудник</th><th>Итог</th><th className="num">Разговор</th><th>Запись</th></tr></thead>
            <tbody>
              {c.calls.map((k) => (
                <tr key={k.id}>
                  <td className="mono small">{fmtDateTime(k.startedAt)}{k.repeat && <div className="pill warn">повторный</div>}</td>
                  <td>{k.userName ?? '—'}</td>
                  <td>{CALL_STATUS[k.status] ?? k.status}{k.error && <div className="err">{k.error}</div>}</td>
                  <td className="num">{fmtSeconds(k.talkSeconds)}</td>
                  <td>{k.records ? (k.canListen ? <span className="muted small">прослушивание — после подключения UIS</span> : <span className="muted small">нет доступа</span>) : '—'}</td>
                </tr>
              ))}
              {!c.calls.length && <tr><td colSpan={5} className="muted">Звонков через кабинет ещё не было</td></tr>}
            </tbody>
          </table></div>
        </section>

        <section className="panel c6">
          <div className="panel-h"><span className="label">СМС</span></div>
          <div className="tbl"><table>
            <thead><tr><th>Когда</th><th>Текст</th><th>Статус</th></tr></thead>
            <tbody>
              {c.sms.map((m) => <tr key={m.id}><td className="mono small">{fmtDateTime(m.createdAt)}<div className="muted">{m.userName}</div></td><td style={{ whiteSpace: 'pre-wrap' }}>{m.text}</td><td>{m.status === 'sent' ? <span className="pill good">Отправлено</span> : <span className="pill bad" title={m.error ?? ''}>Ошибка</span>}</td></tr>)}
              {!c.sms.length && <tr><td colSpan={3} className="muted">СМС не отправлялись</td></tr>}
            </tbody>
          </table></div>
        </section>
      </div>

      {dialog === 'callback' && (
        <CallbackDialog title="Назначить перезвон" onClose={() => setDialog(null)} onSubmit={async (at, note) => {
          await api(`/api/cards/${id}/callback`, { body: { at, note } });
          setDialog(null);
          toast(`Перезвон назначен на ${fmtDateTime(at)}`);
          reload();
        }} />
      )}
      {dialog === 'close' && (
        <Modal title="Снять клиента с обзвона?" onClose={() => setDialog(null)} footer={<>
          <button className="btn" onClick={() => setDialog(null)}>Отмена</button>
          <button className="btn danger" onClick={async () => { setDialog(null); await manage({ action: 'close' }, 'Клиент снят с обзвона'); }}>Снять с обзвона</button>
        </>}>
          <p style={{ margin: 0 }}>Клиент пропадёт из очереди. Анкеты и история сохранятся, вернуть его можно кнопкой «Вернуть в очередь».</p>
        </Modal>
      )}
    </>
  );
}
