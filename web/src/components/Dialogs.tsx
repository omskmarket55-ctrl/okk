import { useState } from 'react';
import { api, errorText } from '../api';
import { toLocalInput } from '../format';
import { Field, Modal, useLoad } from './ui';

/** Выбор даты и времени перезвона. Быстрые варианты — для частых просьб клиента. */
export function CallbackDialog({ title, onClose, onSubmit }: { title: string; onClose: () => void; onSubmit: (at: string, note: string) => Promise<void> }) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(11, 0, 0, 0);
  const [value, setValue] = useState(toLocalInput(tomorrow));
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const quick = (label: string, d: Date) => <button type="button" onClick={() => setValue(toLocalInput(d))}>{label}</button>;
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);
  const at = (days: number, hour: number) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d; };
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await onSubmit(new Date(value).toISOString(), note);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Отмена</button>
      <button className="btn primary" disabled={busy || !value} onClick={submit}>Назначить перезвон</button>
    </>}>
      <div className="chips">{quick('Через час', inHours(1))}{quick('Через 3 часа', inHours(3))}{quick('Завтра в 11:00', at(1, 11))}{quick('Завтра в 18:00', at(1, 18))}{quick('Через неделю', at(7, 11))}</div>
      <Field label="Дата и время"><input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
      <Field label="Комментарий (необязательно)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Просил позвонить после работы" /></Field>
      <p className="muted small" style={{ margin: 0 }}>За 15 минут до этого времени клиент вернётся в очередь с пометкой «Повторный звонок».</p>
      {error && <div className="err">{error}</div>}
    </Modal>
  );
}

interface SmsTemplates { templates: { id: string; name: string; text: string }[]; allowEdit: boolean; defaultProvider: string | null }

export function SmsDialog({ cardId, clientName, providers, onClose, onSent }: { cardId: number; clientName: string; providers: { id: string; name: string }[]; onClose: () => void; onSent: () => void }) {
  const { data } = useLoad(() => api<SmsTemplates>('/api/sms/templates'), []);
  const [provider, setProvider] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const first = clientName.split(/\s+/)[1] ?? clientName;
  const pick = (id: string) => {
    setTemplateId(id);
    const t = data?.templates.find((x) => x.id === id);
    setText(t ? t.text.replaceAll('{имя}', first).replaceAll('{фио}', clientName).replaceAll('{имя отчество}', clientName.split(/\s+/).slice(1).join(' ')) : '');
  };
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/cards/${cardId}/sms`, { body: { provider: provider || data?.defaultProvider, templateId, text } });
      onSent();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="СМС клиенту" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Отмена</button>
      <button className="btn primary" disabled={busy || !text.trim()} onClick={send}>Отправить</button>
    </>}>
      <Field label="Сервис">
        <select value={provider || data?.defaultProvider || ''} onChange={(e) => setProvider(e.target.value)}>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Шаблон">
        <select value={templateId} onChange={(e) => pick(e.target.value)}>
          <option value="">— выберите шаблон —</option>
          {data?.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>
      <Field label={`Текст · ${text.length} символов`}>
        <textarea value={text} readOnly={data ? !data.allowEdit : true} onChange={(e) => setText(e.target.value)} rows={5} />
      </Field>
      <p className="muted small" style={{ margin: 0 }}>Номер подставит сервер, он вам не показывается.</p>
      {error && <div className="err">{error}</div>}
    </Modal>
  );
}
