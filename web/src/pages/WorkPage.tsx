import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, errorText, type Me } from '../api';
import { go } from '../route';
import { chosenAction, type Answers } from '../../../server/src/surveys/schema';
import { Loading, useLoad, useToast } from '../components/ui';
import { SurveyForm } from '../components/SurveyForm';
import { CallbackDialog, SmsDialog } from '../components/Dialogs';
import { eventText, fmtDateTime } from '../format';
import { CallBar } from '../components/CallBar';
import type { CardView, QueueItem } from '../types';

export function WorkPage({ me, cardId }: { me: Me; cardId?: number }) {
  const toast = useToast();
  const queue = useLoad(() => api<{ items: QueueItem[] }>('/api/queue'), []);
  const [card, setCard] = useState<CardView | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);

  // Очередь обновляется раз в 30 секунд: подходят перезвоны, приходят новые сделки
  useEffect(() => {
    const t = setInterval(queue.reload, 30_000);
    return () => clearInterval(t);
  }, [queue.reload]);

  const loadCard = useCallback(async (id: number, open: boolean) => {
    setCardError(null);
    try {
      if (open) await api(`/api/cards/${id}/open`, { body: {} });
      setCard(await api<CardView>(`/api/cards/${id}`));
    } catch (e) {
      setCard(null);
      setCardError(errorText(e));
    }
  }, []);

  useEffect(() => {
    if (cardId) void loadCard(cardId, true);
    else setCard(null);
  }, [cardId, loadCard]);

  const done = (text: string, bad = false) => {
    toast(text, bad);
    go({ page: 'work' });
    queue.reload();
  };

  const items = queue.data?.items ?? [];
  const repeats = items.filter((i) => i.repeat).length;
  return (
    <div className="work">
      <aside className="panel queue">
        <div className="panel-h">
          <span className="label">Очередь</span>
          <span className="row" style={{ gap: 6 }}>
            {repeats > 0 && <span className="pill warn" title="Повторные звонки">↻ {repeats}</span>}
            <span className="pill acc mono">{items.length}</span>
          </span>
        </div>
        {!queue.data ? <Loading error={queue.error} /> : items.length === 0 ? <div className="empty">Очередь пуста. Новые клиенты появятся, когда в Битрикс24 поставят дело.</div> : (
          <ul>
            {items.map((i) => (
              <li key={i.id}>
                <button type="button" aria-pressed={card?.id === i.id} onClick={() => go({ page: 'work', cardId: i.id })}>
                  <span className="n">{i.clientName}</span>
                  <span className="s"><span>{i.dealTitle ?? '—'}</span><span className="mono">••{i.phoneTail ?? '—'}</span></span>
                  <span className="s">
                    {i.repeat ? <span className="pill warn">Повторный звонок</span> : <span>Новый</span>}
                    <span>{i.repeat && i.callbackAt ? fmtDateTime(i.callbackAt).slice(-5) : i.attempts ? `попыток: ${i.attempts}` : ''}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {cardError ? <div className="panel panel-b"><div className="alert bad">{cardError}</div></div>
        : !card ? <div className="panel empty">Выберите клиента в очереди слева</div>
          : <CardWork key={card.id} me={me} card={card} onDone={done} reload={() => loadCard(card.id, false)} />}
    </div>
  );
}

function CardWork({ me, card, onDone, reload }: { me: Me; card: CardView; onDone: (text: string, bad?: boolean) => void; reload: () => void }) {
  const toast = useToast();
  const [answers, setAnswers] = useState<Answers>(card.draftAnswers ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'callback' | 'later' | 'sms' | null>(null);
  const schema = card.survey?.schema;
  const needsCallback = schema ? chosenAction(schema, answers) === 'callback' : false;

  const save = async (callbackAt?: string) => {
    if (!card.survey) return;
    setBusy(true);
    setErrors({});
    try {
      const r = await api<{ outcome: string; leads: { ok: boolean; leadId?: number; error?: string }[] }>(`/api/cards/${card.id}/response`, {
        body: { versionId: card.survey.versionId, answers, callbackAt },
      });
      const failed = r.leads.filter((l) => !l.ok);
      const created = r.leads.filter((l) => l.ok).map((l) => `#${l.leadId}`);
      const parts = [r.outcome === 'callback' ? 'Перезвон назначен' : 'Анкета сохранена'];
      if (created.length) parts.push(`Создан лид ${created.join(', ')} в Битрикс24`);
      if (failed.length) parts.push(`Лид не создан: ${failed[0].error}. Старший может отправить его повторно из карточки клиента`);
      onDone(parts.join('. '), failed.length > 0);
    } catch (e) {
      if (e instanceof ApiError && e.errors) setErrors(e.errors);
      toast(errorText(e), true);
      setBusy(false);
      throw e;
    }
  };

  const onSave = () => (needsCallback ? setDialog('callback') : save().catch(() => undefined));

  return (
    <>
      <div className="stack-lg" style={{ minWidth: 0 }}>
        <section className="panel">
          <div className="panel-b">
            <div className="card-h">
              <div>
                <div className="muted small mono">Сделка #{card.dealId}{card.dealTitle ? ` · ${card.dealTitle}` : ''}</div>
                <h2>{card.clientName}</h2>
              </div>
              <span className={`pill ${card.repeat ? 'warn' : 'acc'}`}>{card.statusLabel}</span>
            </div>
            <dl className="fields">
              {card.fields.map((f) => <div key={f.code}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}
            </dl>
            <CallBar uis={me.integrations.uis} hasPhone={card.hasPhone} phone={card.phone} startUrl={`/api/cards/${card.id}/call`} callsUrl="/api/calls" onChange={reload} />
          </div>
        </section>

        <section className="panel">
          <div className="panel-h"><span className="label">Анкета{card.survey ? ` · ${card.survey.name}` : ''}</span>{card.draftAnswers && <span className="pill warn">Продолжение после перезвона</span>}</div>
          {!schema ? <div className="panel-b"><div className="alert">Анкета не опубликована. Администратор публикует её в разделе «Конструктор анкет».</div></div> : (
            <SurveyForm schema={schema} answers={answers} onChange={setAnswers} clientName={card.clientName} errors={errors} disabled={busy} />
          )}
          <div className="foot">
            {me.integrations.sms.length > 0 && me.permissions.includes('sms.send') && card.hasPhone && <button className="btn" onClick={() => setDialog('sms')}>СМС</button>}
            <span className="grow" />
            <button className="btn" disabled={busy} onClick={() => setDialog('later')}>Перезвонить позже</button>
            <button className="btn primary" disabled={busy || !schema} onClick={onSave}>{needsCallback ? 'Сохранить и назначить перезвон' : 'Сохранить анкету'}</button>
          </div>
        </section>
      </div>

      <aside className="right stack-lg" style={{ minWidth: 0 }}>
        <section className="panel">
          <div className="panel-h"><span className="label">История</span></div>
          <div className="panel-b">
            <ul className="hist">
              {card.events.slice(0, 15).map((e) => (
                <li key={e.id}><time>{fmtDateTime(e.createdAt)}{e.userName ? ` · ${e.userName}` : ''}</time>{eventText(e)}</li>
              ))}
            </ul>
          </div>
        </section>
        <section className="panel">
          <div className="panel-h"><span className="label">Что уйдёт в Битрикс24</span></div>
          <div className="panel-b small">Только новый лид по каждой рекомендации, со ссылкой на сделку клиента. Ответы анкеты остаются в кабинете.</div>
        </section>
      </aside>

      {dialog === 'callback' && (
        <CallbackDialog title="Когда перезвонить клиенту?" onClose={() => setDialog(null)} onSubmit={async (at) => { await save(at); }} />
      )}
      {dialog === 'later' && (
        <CallbackDialog title="Перезвонить позже" onClose={() => setDialog(null)} onSubmit={async (at, note) => {
          await api(`/api/cards/${card.id}/callback`, { body: { at, note } });
          onDone(`Перезвон назначен на ${fmtDateTime(at)}`);
        }} />
      )}
      {dialog === 'sms' && (
        <SmsDialog cardId={card.id} clientName={card.clientName} providers={me.integrations.sms} onClose={() => setDialog(null)} onSent={() => { setDialog(null); toast('СМС отправлено'); reload(); }} />
      )}
    </>
  );
}
