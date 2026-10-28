import { useCallback, useEffect, useState } from 'react';
import { api, errorText, type Me } from '../api';
import { Loading, useLoad, useToast } from '../components/ui';
import { OkcCardPanel } from '../components/OkcCardPanel';
import { fmtDateTime } from '../format';
import type { OkcCard } from '../types';

interface OkcMe {
  status: 'ready' | 'break' | 'offline';
  since: string | null;
  breakSecondsToday: number;
  currentCardId: number | null;
  counts: { meeting: number; agreement: number; later: number; done: number; tasksDue: number };
  bonusAvailable: number;
}

const clock = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

/** Обзвон ОКЦ: статус оператора и карточка, которую выдала система. */
export function OkcWorkPage({ me }: { me: Me }) {
  const toast = useToast();
  const state = useLoad(() => api<OkcMe>('/api/okc/me'), []);
  const [card, setCard] = useState<OkcCard | null>(null);
  const [empty, setEmpty] = useState(false);
  const [now, setNow] = useState(Date.now());
  const s = state.data;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const loadNext = useCallback(async () => {
    try {
      const r = await api<{ cardId: number | null }>('/api/okc/next', { body: {} });
      setEmpty(!r.cardId);
      setCard(r.cardId ? await api<OkcCard>(`/api/okc/cards/${r.cardId}`) : null);
    } catch (e) {
      setCard(null);
      toast(errorText(e), true);
    }
  }, [toast]);

  // В статусе «Готов» карточка выдаётся сразу; если база пуста — проверяем снова раз в 30 секунд
  useEffect(() => {
    if (s?.status !== 'ready') { setCard(null); return; }
    if (!card) void loadNext();
    if (!empty) return;
    const t = setInterval(() => void loadNext(), 30_000);
    return () => clearInterval(t);
  }, [s?.status, empty]); // eslint-disable-line react-hooks/exhaustive-deps

  const setStatus = async (status: OkcMe['status']) => {
    try {
      await api('/api/okc/status', { body: { status } });
      setCard(null);
      setEmpty(false);
      state.reload();
    } catch (e) {
      toast(errorText(e), true);
    }
  };

  if (!s) return <Loading error={state.error} />;
  const sinceSec = s.since ? Math.max(0, Math.floor((now - new Date(s.since).getTime()) / 1000)) : 0;
  return (
    <>
      <div className="page-h">
        <div><div className="label">ОКЦ</div><h1>Обзвон</h1></div>
        <div className="row">
          <a className="pill" href="#/okc-my">Встреч: {s.counts.meeting}</a>
          <a className="pill" href="#/okc-my">Договорённостей: {s.counts.agreement}</a>
          {s.counts.tasksDue > 0 && <a className="pill bad" href="#/okc-my">Дел пора выполнить: {s.counts.tasksDue}</a>}
          <a className="pill good" href="#/bonus">Бонус: {s.bonusAvailable.toLocaleString('ru-RU')} ₽</a>
        </div>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-b row">
          {s.status === 'ready' && <><span className="pill good">Готов</span><span className="mono muted">{clock(sinceSec)}</span></>}
          {s.status === 'break' && <><span className="pill warn">Перерыв</span><span className="mono">{clock(sinceSec)}</span></>}
          {s.status === 'offline' && <span className="pill">Не готов</span>}
          <span className="muted small">Перерывов сегодня: {clock(s.breakSecondsToday)}</span>
          <span className="grow" />
          {s.status === 'offline' && <button className="btn primary" onClick={() => setStatus('ready')}>Готов</button>}
          {s.status === 'ready' && <button className="btn" onClick={() => setStatus('break')}>Перерыв</button>}
          {s.status === 'break' && <button className="btn primary" onClick={() => setStatus('ready')}>Продолжить</button>}
          {s.status !== 'offline' && <button className="btn" onClick={() => setStatus('offline')}>Завершить рабочий день</button>}
        </div>
      </section>

      {s.status === 'offline' && <div className="panel empty">Нажмите «Готов», чтобы получать карточки на обзвон. Назначенные встречи и договорённости — в разделе «Мои карточки».</div>}
      {s.status === 'break' && <div className="panel empty">Перерыв: новые карточки не выдаются. Нажмите «Продолжить», когда вернётесь.</div>}
      {s.status === 'ready' && (card
        ? <OkcCardPanel key={card.id} me={me} card={card} reload={async () => setCard(await api<OkcCard>(`/api/okc/cards/${card.id}`))} onDone={(text) => { toast(text); setCard(null); state.reload(); void loadNext(); }} />
        : <div className="panel empty">{empty ? `Карточек для обзвона сейчас нет. Проверим снова через 30 секунд · ${fmtDateTime(new Date())}` : 'Получаю карточку…'}</div>)}
    </>
  );
}
