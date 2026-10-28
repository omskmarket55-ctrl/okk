import { useState } from 'react';
import { api, errorText, type Me } from '../api';
import { go } from '../route';
import { Field, Loading, useLoad, useToast } from '../components/ui';
import { fmtDateTime } from '../format';

interface Batch { id: number; name: string; total: number; added: number; duplicates: number; invalid: number; createdAt: string; uploadedBy: string | null; left: number }
interface Card { id: number; phone: string; clientName: string | null; status: string; statusLabel: string; ownerName: string | null; attempts: number; meetingAt: string | null; updatedAt: string; refuseReason: string | null }

const STATUSES = [['', 'Все'], ['new', 'В базе'], ['later', 'Позвонить позднее'], ['agreement', 'Договорённость'], ['meeting', 'Встреча назначена'], ['meeting_done', 'Состоялась'], ['meeting_failed', 'Не состоялась'], ['refused', 'Отказ']];

export function OkcBasePage({ me }: { me: Me }) {
  const toast = useToast();
  const batches = useLoad(() => api<{ items: Batch[] }>('/api/okc/batches'), []);
  const ops = useLoad(() => api<{ items: { id: number; name: string }[] }>('/api/okc/operators').catch(() => ({ items: [] })), []);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [tail, setTail] = useState('');
  const [page, setPage] = useState(1);
  const cards = useLoad(() => api<{ total: number; items: Card[] }>(`/api/okc/cards?status=${status}&ownerId=${ownerId}&tail=${tail}&page=${page}`), [status, ownerId, tail, page]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text());
    if (!name) setName(f.name.replace(/\.[^.]+$/, ''));
  };
  const upload = async () => {
    setBusy(true);
    try {
      const r = await api<{ added: number; duplicates: number; invalid: number }>('/api/okc/base', { body: { name, text } });
      toast(`Добавлено карточек: ${r.added}. Уже были в базе: ${r.duplicates}. Не похожи на номер: ${r.invalid}`);
      setText('');
      setName('');
      batches.reload();
      cards.reload();
    } catch (e) {
      toast(errorText(e), true);
    }
    setBusy(false);
  };
  const lines = text ? text.split(/\r?\n/).filter((l) => /\d/.test(l)).length : 0;

  return (
    <>
      <div className="page-h"><div><div className="label">ОКЦ</div><h1>База обзвона</h1></div></div>
      <div className="dash">
        <section className="panel c6">
          <div className="panel-h"><span className="label">Загрузить номера</span></div>
          <div className="panel-b stack">
            <Field label="Название базы"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Выставка октябрь" /></Field>
            <Field label="Файл .txt или .csv — по номеру в строке"><input type="file" accept=".txt,.csv,text/plain,text/csv" onChange={(e) => onFile(e.target.files?.[0])} /></Field>
            <Field label={`Или вставьте номера${lines ? ` · строк с цифрами: ${lines}` : ''}`}><textarea rows={6} className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder={'89131234567\n+7 913 765-43-21'} /></Field>
            <p className="muted small" style={{ margin: 0 }}>Каждый номер — одна карточка. Номера, которые уже есть в базе, пропускаются. Карточки сами распределяются поровну между операторами в статусе «Готов».</p>
          </div>
          <div className="foot"><button className="btn primary" disabled={busy || !text.trim()} onClick={upload}>Загрузить</button></div>
        </section>
        <section className="panel c6">
          <div className="panel-h"><span className="label">Загруженные базы</span></div>
          {!batches.data ? <Loading error={batches.error} /> : (
            <div className="tbl"><table>
              <thead><tr><th>База</th><th className="num">Добавлено</th><th className="num">Дубли</th><th className="num">Ошибки</th><th className="num">Осталось</th></tr></thead>
              <tbody>
                {batches.data.items.map((b) => <tr key={b.id}><td><b>{b.name}</b><div className="small muted">{fmtDateTime(b.createdAt)} · {b.uploadedBy}</div></td><td className="num">{b.added}</td><td className="num">{b.duplicates}</td><td className="num">{b.invalid}</td><td className="num">{b.left}</td></tr>)}
                {!batches.data.items.length && <tr><td colSpan={5} className="muted">Баз пока нет</td></tr>}
              </tbody>
            </table></div>
          )}
        </section>
        <section className="panel c12">
          <div className="panel-h">
            <span className="label">Карточки</span>
            <div className="row">
              <select aria-label="Статус" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }} style={{ width: 'auto' }}>{STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              <select aria-label="Оператор" value={ownerId} onChange={(e) => { setPage(1); setOwnerId(e.target.value); }} style={{ width: 'auto' }}>
                <option value="">Все</option><option value="none">Общая база</option>
                {ops.data?.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              <input aria-label="Последние 2 цифры" placeholder="••47" value={tail} maxLength={2} onChange={(e) => { setPage(1); setTail(e.target.value.replace(/\D/g, '')); }} style={{ width: 80 }} className="mono" />
            </div>
          </div>
          {!cards.data ? <Loading error={cards.error} /> : (
            <div className="tbl"><table>
              <thead><tr><th>Телефон</th><th>Клиент</th><th>Статус</th><th>За кем</th><th className="num">Звонков</th><th>Обновлена</th></tr></thead>
              <tbody>
                {cards.data.items.map((c) => (
                  <tr key={c.id} className="click" onClick={() => go({ page: 'okcCard', id: c.id })}>
                    <td className="mono">{c.phone}</td><td>{c.clientName ?? '—'}</td>
                    <td><span className="pill">{c.statusLabel}</span>{c.refuseReason && <div className="small muted">{c.refuseReason}</div>}{c.meetingAt && <div className="small muted">{fmtDateTime(c.meetingAt)}</div>}</td>
                    <td>{c.ownerName ?? <span className="muted">общая база</span>}</td><td className="num">{c.attempts}</td><td className="mono small">{fmtDateTime(c.updatedAt)}</td>
                  </tr>
                ))}
                {!cards.data.items.length && <tr><td colSpan={6} className="muted">Ничего не нашлось</td></tr>}
              </tbody>
            </table></div>
          )}
          {cards.data && cards.data.total > 50 && (
            <div className="foot">
              <span className="muted small">Всего: {cards.data.total}</span>
              <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Назад</button>
              <span className="mono small">{page} / {Math.ceil(cards.data.total / 50)}</span>
              <button className="btn sm" disabled={page >= Math.ceil(cards.data.total / 50)} onClick={() => setPage(page + 1)}>Дальше</button>
            </div>
          )}
        </section>
      </div>
      {!me.permissions.includes('phones.view') && <p className="muted small">Полные номера видны с правом «Видеть полный номер клиента».</p>}
    </>
  );
}
