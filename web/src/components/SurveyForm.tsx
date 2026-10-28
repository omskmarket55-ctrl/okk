import { visibleQuestions, fillScript, type Answers, type Answer, type Question, type ReferralAnswer, type SurveySchema } from '../../../server/src/surveys/schema';

/** Маска ввода телефона: +7 (913) 123-45-67 */
export function phoneMask(v: string): string {
  let d = v.replace(/\D/g, '');
  if (d.startsWith('8')) d = `7${d.slice(1)}`;
  if (d && !d.startsWith('7')) d = `7${d}`;
  d = d.slice(0, 11);
  if (!d) return '';
  let o = '+7';
  if (d.length > 1) o += ` (${d.slice(1, 4)}`;
  if (d.length >= 4) o += ')';
  if (d.length > 4) o += ` ${d.slice(4, 7)}`;
  if (d.length > 7) o += `-${d.slice(7, 9)}`;
  if (d.length > 9) o += `-${d.slice(9, 11)}`;
  return o;
}

interface Props {
  schema: SurveySchema;
  answers: Answers;
  onChange: (a: Answers) => void;
  clientName: string;
  errors?: Record<string, string>;
  disabled?: boolean;
}

/** Анкета для оператора: вопросы появляются по условиям, текст скрипта — с именем клиента. */
export function SurveyForm({ schema, answers, onChange, clientName, errors = {}, disabled }: Props) {
  const set = (id: string, v: Answer) => onChange({ ...answers, [id]: v });
  const questions = visibleQuestions(schema, answers);
  const say = (t?: string) => (t ? fillScript(t, { fullName: clientName }) : '');
  return (
    <div>
      {schema.intro && <div className="q"><div className="label">Вступление</div><p className="say" style={{ marginTop: 6 }}>{say(schema.intro)}</p></div>}
      {questions.map((q, i) => (
        <div key={q.id} className={`q${errors[q.id] ? ' has-err' : ''}`}>
          <h3>{i + 1}. {q.title}{q.required && q.type !== 'info' ? <span className="muted"> *</span> : null}</h3>
          {q.script && <p className="say" style={{ marginTop: 4 }}>{say(q.script)}</p>}
          <QuestionInput q={q} value={answers[q.id]} onChange={(v) => set(q.id, v)} disabled={disabled} />
          {errors[q.id] && <div className="err" style={{ marginTop: 6 }}>{errors[q.id]}</div>}
        </div>
      ))}
      {schema.outro && <div className="q"><div className="label">Завершение</div><p className="say" style={{ marginTop: 6 }}>{say(schema.outro)}</p></div>}
    </div>
  );
}

function QuestionInput({ q, value, onChange, disabled }: { q: Question; value: Answer | undefined; onChange: (v: Answer) => void; disabled?: boolean }) {
  switch (q.type) {
    case 'nps':
      return (
        <>
          <div className="nps">
            {Array.from({ length: 11 }, (_, n) => (
              <button key={n} type="button" disabled={disabled} className={n <= 6 ? 'd' : n <= 8 ? 'p' : 'g'} aria-pressed={value === n} onClick={() => onChange(n)}>{n}</button>
            ))}
          </div>
          <div className="scale"><span>0 · точно нет</span><span>10 · обязательно</span></div>
        </>
      );
    case 'single':
      return (
        <div className="chips">
          {(q.options ?? []).map((o) => (
            <button key={o.id} type="button" disabled={disabled} aria-pressed={value === o.id} onClick={() => onChange(value === o.id ? null : o.id)}>{o.label}</button>
          ))}
        </div>
      );
    case 'multi': {
      const list = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="chips">
          {(q.options ?? []).map((o) => (
            <button key={o.id} type="button" disabled={disabled} aria-pressed={list.includes(o.id)}
              onClick={() => onChange(list.includes(o.id) ? list.filter((x) => x !== o.id) : [...list, o.id])}>{o.label}</button>
          ))}
        </div>
      );
    }
    case 'yesno':
      return (
        <div className="chips">
          <button type="button" disabled={disabled} aria-pressed={value === true} onClick={() => onChange(value === true ? null : true)}>Да</button>
          <button type="button" disabled={disabled} aria-pressed={value === false} onClick={() => onChange(value === false ? null : false)}>Нет</button>
        </div>
      );
    case 'text':
      return <textarea disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} aria-label={q.title} />;
    case 'date':
      return <input type="date" disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} aria-label={q.title} style={{ maxWidth: 200 }} />;
    case 'referral':
      return <ReferralInput q={q} value={Array.isArray(value) ? (value as ReferralAnswer[]) : []} onChange={onChange} disabled={disabled} />;
    case 'info':
      return null;
  }
}

function ReferralInput({ q, value, onChange, disabled }: { q: Question; value: ReferralAnswer[]; onChange: (v: Answer) => void; disabled?: boolean }) {
  const list = value.length ? value : [{ name: '', phone: '', comment: '' }];
  const update = (i: number, patch: Partial<ReferralAnswer>) => onChange(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack">
      <p className="say">Номер вводится со слов клиента. После сохранения в Битрикс24 создаётся лид с источником «Рекомендация».</p>
      {list.map((r, i) => (
        <div key={i} className="grid3">
          <label className="fld"><span>Имя</span><input disabled={disabled} value={r.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Игорь" /></label>
          <label className="fld"><span>Телефон</span><input disabled={disabled} className="mono" inputMode="tel" value={r.phone} onChange={(e) => update(i, { phone: phoneMask(e.target.value) })} placeholder="+7 (___) ___-__-__" /></label>
          <label className="fld"><span>Комментарий: кто это, что интересует</span><input disabled={disabled} value={r.comment ?? ''} onChange={(e) => update(i, { comment: e.target.value })} placeholder="Сосед, окна на дачу" /></label>
        </div>
      ))}
      <div className="row">
        {list.length < (q.maxItems ?? 3) && <button type="button" className="btn sm" disabled={disabled} onClick={() => onChange([...list, { name: '', phone: '', comment: '' }])}>Добавить ещё контакт</button>}
        {list.length > 1 && <button type="button" className="btn sm ghost" disabled={disabled} onClick={() => onChange(list.slice(0, -1))}>Убрать последний</button>}
      </div>
    </div>
  );
}

/** Ответы прошлой анкеты в читаемом виде: для карточки клиента у администратора. */
export function AnswersView({ schema, answers }: { schema: SurveySchema; answers: Record<string, unknown> }) {
  const qs = visibleQuestions(schema, answers as Answers).filter((q) => q.type !== 'info');
  return (
    <div className="kv">
      {qs.map((q) => {
        const a = answers[q.id];
        let text: string;
        if (a === undefined || a === null || a === '') text = '—';
        else if (q.type === 'single' || q.type === 'multi') text = [a].flat().map((id) => q.options?.find((o) => o.id === id)?.label ?? String(id)).join(', ');
        else if (q.type === 'yesno') text = a ? 'Да' : 'Нет';
        else if (q.type === 'referral') text = (a as { name: string; phoneTail: string; comment?: string }[]).map((r) => `${r.name} (••${r.phoneTail})${r.comment ? ` — ${r.comment}` : ''}`).join('; ');
        else if (q.type === 'date') text = new Date(String(a)).toLocaleDateString('ru-RU');
        else text = String(a);
        return <div key={q.id}><span>{q.title}</span><span style={{ textAlign: 'right', whiteSpace: 'pre-wrap' }}>{text}</span></div>;
      })}
    </div>
  );
}
