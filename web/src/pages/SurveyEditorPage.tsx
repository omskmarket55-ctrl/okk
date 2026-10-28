import { useEffect, useState } from 'react';
import { api, ApiError, errorText, type Me } from '../api';
import { Field, Loading, Modal, useLoad, useToast } from '../components/ui';
import { SurveyForm } from '../components/SurveyForm';
import { fmtDateTime } from '../format';
import {
  QUESTION_TYPES, schemaProblems,
  type Answers, type Condition, type ConditionOp, type Question, type QuestionType, type SurveySchema,
} from '../../../server/src/surveys/schema';

interface SurveyData { id: number; name: string; archived: boolean; draft: SurveySchema; published: SurveySchema | null; activeVersion: number | null; versions: { version: number; publishedAt: string; publishedBy: string | null }[] }

const uid = () => Math.random().toString(36).slice(2, 8);
const OPS: { op: ConditionOp; label: string }[] = [
  { op: 'eq', label: 'равно' }, { op: 'neq', label: 'не равно' }, { op: 'lte', label: 'не больше' }, { op: 'gte', label: 'не меньше' }, { op: 'answered', label: 'есть ответ' },
];
const hasOptions = (t: QuestionType) => t === 'single' || t === 'multi';

export function SurveyEditorPage({ me, id }: { me: Me; id: number }) {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api<SurveyData>(`/api/surveys/${id}`), [id]);
  const [schema, setSchema] = useState<SurveySchema | null>(null);
  const [name, setName] = useState('');
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<Answers>({});
  const [confirm, setConfirm] = useState(false);
  const canEdit = me.permissions.includes('surveys.edit');
  const canPublish = me.permissions.includes('surveys.publish');

  useEffect(() => {
    if (data) { setSchema(structuredClone(data.draft)); setName(data.name); setDirty(false); }
  }, [data]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!data || !schema) return <Loading error={error} />;

  const change = (s: SurveySchema) => { setSchema(s); setDirty(true); };
  const setQ = (i: number, patch: Partial<Question>) => change({ ...schema, questions: schema.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
  const move = (i: number, d: number) => {
    const qs = [...schema.questions];
    const [q] = qs.splice(i, 1);
    qs.splice(i + d, 0, q);
    change({ ...schema, questions: qs });
  };
  const add = (type: QuestionType) => {
    const q: Question = { id: `q${uid()}`, type, title: QUESTION_TYPES.find((t) => t.type === type)!.label, script: '', required: type === 'nps' };
    if (hasOptions(type)) q.options = [{ id: uid(), label: 'Вариант 1' }, { id: uid(), label: 'Вариант 2' }];
    if (type === 'referral') q.maxItems = 3;
    change({ ...schema, questions: [...schema.questions, q] });
  };
  const remove = (i: number) => {
    const qid = schema.questions[i].id;
    change({ ...schema, questions: schema.questions.filter((_, j) => j !== i).map((q) => ({ ...q, showIf: q.showIf?.filter((c) => c.questionId !== qid) })) });
  };

  const save = async () => {
    try {
      const r = await api<{ problems: string[] }>(`/api/surveys/${id}`, { method: 'PUT', body: { name, draft: schema } });
      setDirty(false);
      toast(r.problems.length ? `Черновик сохранён. Перед публикацией исправьте: ${r.problems[0]}` : 'Черновик сохранён', r.problems.length > 0);
      return true;
    } catch (e) {
      toast(errorText(e), true);
      return false;
    }
  };
  const publish = async () => {
    setConfirm(false);
    if (!(await save())) return;
    try {
      const r = await api<{ version: number }>(`/api/surveys/${id}/publish`, { body: {} });
      toast(`Опубликована версия ${r.version}. Сотрудники видят её со следующей карточки`);
      reload();
    } catch (e) {
      toast(e instanceof ApiError && e.problems ? e.problems.join('; ') : errorText(e), true);
    }
  };
  const archive = async () => {
    await api(`/api/surveys/${id}`, { method: 'PUT', body: { draft: schema, archived: !data.archived } });
    reload();
  };

  const problems = schemaProblems(schema);
  return (
    <>
      <div className="page-h">
        <div>
          <a href="#/surveys" className="small">← Все анкеты</a>
          <div className="row" style={{ marginTop: 4 }}>
            {canEdit ? <input aria-label="Название анкеты" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} style={{ fontSize: 20, fontWeight: 700, width: 360 }} /> : <h1>{name}</h1>}
            {data.activeVersion ? <span className="pill good">Опубликована версия {data.activeVersion}</span> : <span className="pill">Не опубликована</span>}
            {dirty && <span className="pill warn">Есть несохранённые правки</span>}
          </div>
        </div>
        {canEdit && (
          <div className="row">
            <button className="btn" onClick={archive}>{data.archived ? 'Вернуть из архива' : 'В архив'}</button>
            <button className="btn" disabled={!dirty} onClick={save}>Сохранить черновик</button>
            {canPublish && <button className="btn primary" disabled={problems.length > 0} title={problems[0]} onClick={() => setConfirm(true)}>Опубликовать</button>}
          </div>
        )}
      </div>
      {problems.length > 0 && <div className="alert" style={{ marginBottom: 12 }}>Перед публикацией: {problems.join('; ')}</div>}

      <div className="builder">
        <div className="stack">
          <section className="panel panel-b stack">
            <Field label="Вступление — оператор говорит его до первого вопроса. Подстановки: {имя}, {имя отчество}, {фио}">
              <textarea disabled={!canEdit} value={schema.intro ?? ''} onChange={(e) => change({ ...schema, intro: e.target.value })} />
            </Field>
          </section>

          {schema.questions.map((q, i) => (
            <QuestionEditor key={q.id} q={q} index={i} earlier={schema.questions.slice(0, i)} disabled={!canEdit}
              onChange={(p) => setQ(i, p)} onRemove={() => remove(i)}
              onUp={i > 0 ? () => move(i, -1) : undefined} onDown={i < schema.questions.length - 1 ? () => move(i, 1) : undefined} />
          ))}

          {canEdit && (
            <section className="panel panel-b">
              <div className="label" style={{ marginBottom: 8 }}>Добавить вопрос</div>
              <div className="chips">{QUESTION_TYPES.map((t) => <button key={t.type} type="button" onClick={() => add(t.type)}>+ {t.label}</button>)}</div>
            </section>
          )}

          <section className="panel panel-b">
            <Field label="Завершение разговора"><textarea disabled={!canEdit} value={schema.outro ?? ''} onChange={(e) => change({ ...schema, outro: e.target.value })} /></Field>
          </section>

          {data.versions.length > 0 && (
            <section className="panel">
              <div className="panel-h"><span className="label">Опубликованные версии</span></div>
              <div className="panel-b small"><ul className="hist">{data.versions.map((v) => <li key={v.version}>Версия {v.version} · {fmtDateTime(v.publishedAt)} · {v.publishedBy ?? '—'}</li>)}</ul></div>
            </section>
          )}
        </div>

        <aside className="panel preview">
          <div className="panel-h"><span className="label">Как увидит оператор</span><button className="btn sm ghost" onClick={() => setPreview({})}>Сбросить ответы</button></div>
          <SurveyForm schema={schema} answers={preview} onChange={setPreview} clientName="Смирнова Елена Викторовна" />
        </aside>
      </div>

      {confirm && (
        <Modal title="Опубликовать анкету?" onClose={() => setConfirm(false)} footer={<>
          <button className="btn" onClick={() => setConfirm(false)}>Отмена</button>
          <button className="btn primary" onClick={publish}>Опубликовать</button>
        </>}>
          <p style={{ margin: 0 }}>Сотрудники начнут работать по новой версии со следующей открытой карточки. Уже заполненные анкеты сохранят свою версию вопросов.</p>
        </Modal>
      )}
    </>
  );
}

function QuestionEditor({ q, index, earlier, disabled, onChange, onRemove, onUp, onDown }: {
  q: Question; index: number; earlier: Question[]; disabled: boolean;
  onChange: (p: Partial<Question>) => void; onRemove: () => void; onUp?: () => void; onDown?: () => void;
}) {
  const conds = q.showIf ?? [];
  const setCond = (i: number, p: Partial<Condition>) => onChange({ showIf: conds.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const typeLabel = QUESTION_TYPES.find((t) => t.type === q.type)?.label;
  return (
    <section className="qedit">
      <div className="qedit-h">
        <b className="mono">{index + 1}</b>
        <span className="pill acc">{typeLabel}</span>
        {conds.length > 0 && <span className="pill warn">по условию</span>}
        <span className="grow" />
        {!disabled && <>
          <button className="btn sm ghost" disabled={!onUp} onClick={onUp} aria-label="Выше">↑</button>
          <button className="btn sm ghost" disabled={!onDown} onClick={onDown} aria-label="Ниже">↓</button>
          <button className="btn sm ghost" onClick={onRemove}>Удалить</button>
        </>}
      </div>
      <div className="qedit-b">
        <div className="grid2">
          <Field label="Короткое название (в отчётах)"><input disabled={disabled} value={q.title} onChange={(e) => onChange({ title: e.target.value })} /></Field>
          {q.type !== 'info' && <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" disabled={disabled} checked={Boolean(q.required)} onChange={(e) => onChange({ required: e.target.checked })} /><span>Обязательный вопрос</span></label>}
        </div>
        <Field label="Что говорит оператор"><textarea disabled={disabled} value={q.script ?? ''} onChange={(e) => onChange({ script: e.target.value })} rows={2} /></Field>

        {hasOptions(q.type) && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="small muted">Варианты ответа</span>
            {(q.options ?? []).map((o, i) => (
              <div key={o.id} className="opt">
                <input disabled={disabled} aria-label={`Вариант ${i + 1}`} value={o.label} onChange={(e) => onChange({ options: q.options!.map((x) => (x.id === o.id ? { ...x, label: e.target.value } : x)) })} />
                <select disabled={disabled} aria-label="Действие" value={o.action ?? ''} onChange={(e) => onChange({ options: q.options!.map((x) => (x.id === o.id ? { ...x, action: (e.target.value || undefined) as 'callback' | 'refuse' | undefined } : x)) })}>
                  <option value="">без действия</option>
                  <option value="callback">→ перезвонить (выбрать дату)</option>
                  <option value="refuse">→ клиент отказался от опроса</option>
                </select>
                {!disabled && <button className="btn sm ghost" onClick={() => onChange({ options: q.options!.filter((x) => x.id !== o.id) })} aria-label="Убрать вариант">✕</button>}
              </div>
            ))}
            {!disabled && <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => onChange({ options: [...(q.options ?? []), { id: uid(), label: `Вариант ${(q.options?.length ?? 0) + 1}` }] })}>Добавить вариант</button>}
          </div>
        )}
        {q.type === 'referral' && (
          <Field label="Сколько контактов можно записать"><input type="number" min={1} max={10} disabled={disabled} value={q.maxItems ?? 3} onChange={(e) => onChange({ maxItems: Number(e.target.value) })} style={{ width: 100 }} /></Field>
        )}

        {earlier.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="small muted">Показывать, только если{conds.length ? ' (все условия)' : ' — всегда показывается'}</span>
            {conds.map((c, i) => {
              const src = earlier.find((x) => x.id === c.questionId);
              return (
                <div key={i} className="cond">
                  <select disabled={disabled} aria-label="Вопрос" value={c.questionId} onChange={(e) => setCond(i, { questionId: e.target.value, value: undefined })}>
                    {earlier.map((x, j) => <option key={x.id} value={x.id}>{j + 1}. {x.title}</option>)}
                  </select>
                  <select disabled={disabled} aria-label="Условие" value={c.op} onChange={(e) => setCond(i, { op: e.target.value as ConditionOp })}>
                    {OPS.filter((o) => src?.type === 'nps' || !['lte', 'gte'].includes(o.op)).map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                  </select>
                  {c.op === 'answered' ? <span /> : <CondValue src={src} value={c.value} disabled={disabled} onChange={(v) => setCond(i, { value: v })} />}
                  {!disabled && <button className="btn sm ghost" onClick={() => onChange({ showIf: conds.filter((_, j) => j !== i) })} aria-label="Убрать условие">✕</button>}
                </div>
              );
            })}
            {!disabled && <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => onChange({ showIf: [...conds, { questionId: earlier[earlier.length - 1].id, op: 'answered' }] })}>Добавить условие</button>}
          </div>
        )}
      </div>
    </section>
  );
}

function CondValue({ src, value, disabled, onChange }: { src?: Question; value: Condition['value']; disabled: boolean; onChange: (v: Condition['value']) => void }) {
  if (src?.type === 'nps') return <input type="number" min={0} max={10} disabled={disabled} aria-label="Оценка" value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(Number(e.target.value))} />;
  if (src?.type === 'yesno') return <select disabled={disabled} aria-label="Ответ" value={value === true ? 'y' : value === false ? 'n' : ''} onChange={(e) => onChange(e.target.value === 'y')}><option value="">—</option><option value="y">Да</option><option value="n">Нет</option></select>;
  if (src && hasOptions(src.type)) return <select disabled={disabled} aria-label="Вариант" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{src.options?.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>;
  return <input disabled={disabled} aria-label="Значение" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
}
