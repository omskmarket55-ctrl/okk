import { useState } from 'react';
import { api, errorText, type Me } from '../api';
import { Field, Modal, useLoad, useToast } from './ui';
import { CallBar } from './CallBar';
import { fmtDateTime, fmtSeconds, toLocalInput } from '../format';
import { CALL_STATUS, OKC_EVENT_TEXT, type OkcCard } from '../types';

type Dialog = 'agreement' | 'refuse' | 'meeting' | null;
const WORKABLE = ['new', 'later', 'agreement', 'meeting_failed'];

/**
 * Карточка ОКЦ: телефон (маской), история всех операторов, комментарий и итоговые кнопки.
 * onDone вызывается после итога (позднее, договорённость, отказ, встреча) — рабочий стол открывает следующую карточку.
 */
export function OkcCardPanel({ me, card, reload, onDone }: { me: Me; card: OkcCard; reload: () => void; onDone?: (text: string) => void }) {
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const act = card.canAct && me.permissions.includes('okc.work');
  const workable = WORKABLE.includes(card.status);
  const finish = (text: string) => {
    setDialog(null);
    if (onDone) onDone(text);
    else { toast(text); reload(); }
  };
  const run = async (fn: () => Promise<unknown>, text: string) => {
    setBusy(true);
    try {
      await fn();
      finish(text);
    } catch (e) {
      toast(errorText(e), true);
    }
    setBusy(false);
  };
  const saveComment = async () => {
    try {
      await api(`/api/okc/cards/${card.id}/comment`, { body: { text: comment } });
      setComment('');
      reload();
    } catch (e) {
      toast(errorText(e), true);
    }
  };

  return (
    <div className="stack-lg" style={{ minWidth: 0 }}>
      <section className="panel">
        <div className="panel-b">
          <div className="card-h">
            <div>
              <div className="muted small mono">Карточка #{card.id}{card.batchName ? ` · ${card.batchName}` : ''}{card.attempts ? ` · звонков: ${card.attempts}` : ''}</div>
              <h2>{card.clientName || 'Клиент из базы обзвона'}</h2>
            </div>
            <span className={`pill ${card.status === 'meeting' || card.status === 'meeting_done' ? 'good' : card.status === 'refused' ? 'bad' : card.status === 'new' ? 'acc' : 'warn'}`}>{card.statusLabel}</span>
          </div>
          <div className="fields">
            {card.ownerName && <div><dt>Закреплена за</dt><dd>{card.ownerName}{card.pinUntil ? ` до ${fmtDateTime(card.pinUntil).slice(0, 10)}` : ''}</dd></div>}
            {card.callbackAt && <div><dt>Договорились позвонить</dt><dd>{fmtDateTime(card.callbackAt)}</dd></div>}
            {card.refuseReason && <div><dt>Причина отказа</dt><dd>{card.refuseReason}</dd></div>}
            {card.meeting && <>
              <div><dt>Встреча</dt><dd>{fmtDateTime(card.meeting.at)}</dd></div>
              <div><dt>Тип и место</dt><dd>{card.meeting.typeLabel} · {card.meeting.regionLabel}</dd></div>
              <div><dt>Назначил</dt><dd>{card.meeting.byName ?? '—'}</dd></div>
            </>}
            {card.dealId && <div><dt>Сделка ОКЦ</dt><dd>{card.dealUrl ? <a href={card.dealUrl} target="_blank" rel="noreferrer">#{card.dealId} ↗</a> : `#${card.dealId}`}</dd></div>}
          </div>
          {card.bitrixError && <div className="alert bad" style={{ marginTop: 12 }}>Битрикс24: {card.bitrixError}</div>}
          <CallBar uis={me.integrations.uis} hasPhone phone={card.phone} startUrl={`/api/okc/cards/${card.id}/call`} callsUrl="/api/okc/calls" onChange={reload} disabled={!act} />
        </div>
        {act && (
          <div className="panel-b" style={{ borderTop: '1px solid var(--line)' }}>
            <Field label="Комментарий — его увидят все, кто будет звонить по этой карточке">
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="О чём договорились, что важно клиенту" />
            </Field>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm" disabled={!comment.trim()} onClick={saveComment}>Сохранить комментарий</button>
            </div>
          </div>
        )}
        {act && workable && (
          <div className="foot">
            <button className="btn" disabled={busy} onClick={() => run(async () => { if (comment.trim()) await api(`/api/okc/cards/${card.id}/comment`, { body: { text: comment } }); await api(`/api/okc/cards/${card.id}/later`, { body: {} }); }, 'Перезвоним через час')}>Позвонить позднее</button>
            <button className="btn" disabled={busy} onClick={() => setDialog('agreement')}>Есть договорённость</button>
            <button className="btn" disabled={busy} onClick={() => setDialog('refuse')}>Отказ</button>
            <span className="grow" />
            <button className="btn primary" disabled={busy} onClick={() => setDialog('meeting')}>Согласен на встречу</button>
          </div>
        )}
      </section>

      {card.tasks.length > 0 && <TasksPanel card={card} reload={reload} canEdit={act} />}

      <section className="panel">
        <div className="panel-h"><span className="label">История карточки</span></div>
        <div className="panel-b">
          {!card.events.length ? <p className="muted" style={{ margin: 0 }}>По этому номеру ещё не звонили</p> : (
            <ul className="hist">{card.events.map((e) => (
              <li key={e.id}><time>{fmtDateTime(e.createdAt)}{e.userName ? ` · ${e.userName}` : ''}</time>
                <span style={e.type === 'comment' ? { whiteSpace: 'pre-wrap', fontWeight: 500 } : undefined}>{OKC_EVENT_TEXT[e.type]?.(e.data) ?? e.type}</span></li>
            ))}</ul>
          )}
        </div>
      </section>

      {card.calls.length > 0 && (
        <section className="panel">
          <div className="panel-h"><span className="label">Звонки</span></div>
          <div className="tbl"><table>
            <thead><tr><th>Когда</th><th>Сотрудник</th><th>Итог</th><th className="num">Разговор</th><th>Запись</th></tr></thead>
            <tbody>{card.calls.map((k) => (
              <tr key={k.id}><td className="mono small">{fmtDateTime(k.startedAt)}</td><td>{k.userName ?? '—'}</td><td>{CALL_STATUS[k.status] ?? k.status}</td>
                <td className="num">{fmtSeconds(k.talkSeconds)}</td><td>{k.records ? (k.canListen ? <span className="muted small">прослушивание — после подключения UIS</span> : <span className="muted small">нет доступа</span>) : '—'}</td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      {dialog === 'agreement' && <AgreementDialog onClose={() => setDialog(null)} onSubmit={(at) => run(async () => {
        if (comment.trim()) await api(`/api/okc/cards/${card.id}/comment`, { body: { text: comment } });
        await api(`/api/okc/cards/${card.id}/agreement`, { body: { at } });
      }, `Договорённость сохранена: звонок ${fmtDateTime(at)}`)} />}
      {dialog === 'refuse' && <RefuseDialog onClose={() => setDialog(null)} onSubmit={(reasonId) => run(async () => {
        if (comment.trim()) await api(`/api/okc/cards/${card.id}/comment`, { body: { text: comment } });
        await api(`/api/okc/cards/${card.id}/refuse`, { body: { reasonId } });
      }, 'Отказ сохранён')} />}
      {dialog === 'meeting' && <MeetingDialog defaultName={card.clientName ?? ''} defaultComment={comment} onClose={() => setDialog(null)} onSubmit={async (body) => {
        const r = await api<{ deal: { ok: boolean; dealId?: number; error?: string } }>(`/api/okc/cards/${card.id}/meeting`, { body });
        finish(r.deal.ok ? `Записан на встречу. Сделка #${r.deal.dealId} создана в Битрикс24` : `Записан на встречу. Сделка в Битрикс24 не создана: ${r.deal.error}`);
      }} />}
    </div>
  );
}

function TasksPanel({ card, reload, canEdit }: { card: OkcCard; reload: () => void; canEdit: boolean }) {
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
    <section className="panel">
      <div className="panel-h"><span className="label">Дела</span></div>
      <div className="panel-b stack">
        {card.tasks.map((t) => (
          <div key={t.id} className="row">
            <span className={`pill ${t.doneAt ? 'good' : new Date(t.dueAt) < new Date() ? 'bad' : 'warn'}`}>{t.doneAt ? 'выполнено' : 'Напомнить о встрече'}</span>
            <span className="mono">{fmtDateTime(t.dueAt)}</span>
            <span className="grow" />
            {canEdit && !t.doneAt && (moving === t.id ? <>
              <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 'auto' }} />
              <button className="btn sm primary" onClick={() => save(t.id, { dueAt: new Date(value).toISOString() })}>Перенести</button>
              <button className="btn sm ghost" onClick={() => setMoving(null)}>Отмена</button>
            </> : <>
              <button className="btn sm" onClick={() => { setMoving(t.id); setValue(toLocalInput(new Date(Date.now() + 3_600_000))); }}>Перенести</button>
              <button className="btn sm" onClick={() => save(t.id, { done: true })}>Выполнено</button>
            </>)}
          </div>
        ))}
      </div>
    </section>
  );
}

function AgreementDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (at: string) => void }) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(11, 0, 0, 0);
  const [value, setValue] = useState(toLocalInput(d));
  return (
    <Modal title="Когда позвонить клиенту?" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={!value} onClick={() => onSubmit(new Date(value).toISOString())}>Сохранить договорённость</button></>}>
      <Field label="Дата и время звонка"><input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
      <p className="muted small" style={{ margin: 0 }}>Карточка закрепится за вами на 30 дней и будет в разделе «Мои карточки» → «Есть договорённость». В назначенное время она придёт на обзвон первой.</p>
    </Modal>
  );
}

function RefuseDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (reasonId: number) => void }) {
  const { data } = useLoad(() => api<{ items: { id: number; name: string; active: boolean }[] }>('/api/okc/reasons'), []);
  const [reason, setReason] = useState<number | null>(null);
  return (
    <Modal title="Причина отказа" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn danger" disabled={!reason} onClick={() => reason && onSubmit(reason)}>Поставить отказ</button></>}>
      <div className="chips">{data?.items.filter((r) => r.active).map((r) => <button key={r.id} type="button" aria-pressed={reason === r.id} onClick={() => setReason(r.id)}>{r.name}</button>)}</div>
      <p className="muted small" style={{ margin: 0 }}>После отказа карточка больше не попадёт в обзвон. Вернуть её может супервайзер.</p>
    </Modal>
  );
}

interface MeetingBody { at: string; type: string; region: string; clientName: string; comment: string }

function MeetingDialog({ defaultName, defaultComment, onClose, onSubmit }: { defaultName: string; defaultComment: string; onClose: () => void; onSubmit: (b: MeetingBody) => Promise<void> }) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(12, 0, 0, 0);
  const [at, setAt] = useState(toLocalInput(d));
  const [type, setType] = useState('');
  const [region, setRegion] = useState('');
  const [clientName, setClientName] = useState(defaultName);
  const [comment, setComment] = useState(defaultComment);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await onSubmit({ at: new Date(at).toISOString(), type, region, clientName, comment });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="Запись на встречу" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Отмена</button><button className="btn primary" disabled={busy || !at || !type || !region || !clientName.trim()} onClick={submit}>Записать на встречу</button></>}>
      <Field label="Имя клиента"><input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Иван Петрович" autoFocus /></Field>
      <Field label="Дата и время встречи"><input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
      <div>
        <div className="small muted" style={{ marginBottom: 4 }}>Тип встречи</div>
        <div className="chips">
          <button type="button" aria-pressed={type === 'office'} onClick={() => setType('office')}>Офисная</button>
          <button type="button" aria-pressed={type === 'dks'} onClick={() => setType('dks')}>ДКС</button>
        </div>
      </div>
      <Field label="Город / область">
        <select value={region} onChange={(e) => setRegion(e.target.value)}>
          <option value="">— выберите —</option>
          <option value="city">Город</option>
          <option value="region">Область</option>
          <option value="outside">Не Пермский край</option>
        </select>
      </Field>
      <Field label="Комментарий для сделки"><textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
      <p className="muted small" style={{ margin: 0 }}>
        В Битрикс24 создастся сделка в воронке ОКЦ на стадии «Встреча назначена» и событие в календаре {region === 'outside' ? '«Встречи ОУП»' : '«Встречи ОП»'}.
        {type === 'office' ? ' Если встреча завтра или позже, за 3 часа до неё вам придёт дело «Напомнить о встрече».' : ''}
      </p>
      {error && <div className="err">{error}</div>}
    </Modal>
  );
}
