import { useEffect, useState, type ReactNode } from 'react';
import { api, errorText } from '../api';
import { Field, Loading, useLoad, useToast } from '../components/ui';
import { fmtDateTime } from '../format';

interface Settings {
  source: { enabled: boolean; providerId: string; providerTypeId: string; subjectContains: string; responsibleIds: number[]; categoryId: number | null; stageIds: string[]; sinceDate: string; surveyId: number | null; completeActivity: boolean };
  cardFields: { fields: { code: string; label: string }[] };
  lead: { sourceId: string; assignedById: number | null; titleTemplate: string; refDealField: string };
  queue: { callbackLeadMinutes: number };
  uis: { virtualNumber: string };
  sms: { defaultProvider: string | null; providers: Record<string, { enabled: boolean; sender: string; credentials: Record<string, string> } | undefined>; templates: { id: string; name: string; text: string }[]; allowEdit: boolean };
  syncState: { lastActivityId: number; lastRunAt: string | null; lastError: string | null; imported: number };
}
interface SettingsResponse {
  settings: Settings;
  env: { bitrix: boolean; bitrixPortal: string; bitrixOutgoing: boolean; uis: boolean; uisHook: boolean; publicUrl: string };
  smsProviders: { id: string; name: string; credentialFields: { key: string; label: string; secret?: boolean }[] }[];
}

type Opt = { id: string | number; name: string };
const list = <T,>(url: string, enabled: boolean) => () => (enabled ? api<{ items: T[] }>(url) : Promise.resolve({ items: [] as T[] }));

export function SettingsPage() {
  const { data, error, reload } = useLoad(() => api<SettingsResponse>('/api/settings'), []);
  if (!data) return <Loading error={error} />;
  const { env } = data;
  return (
    <>
      <div className="page-h"><div><div className="label">Администрирование</div><h1>Настройки</h1></div></div>
      <div className="stack-lg">
        <section className="panel">
          <div className="panel-h"><span className="label">Подключения</span></div>
          <div className="panel-b kv">
            <div><span>Битрикс24, входящий вебхук</span><span>{env.bitrix ? <span className="pill good">подключён · {env.bitrixPortal}</span> : <span className="pill bad">не задан BITRIX_WEBHOOK_URL в .env</span>}</span></div>
            <div><span>Битрикс24, события о новых делах</span><span>{env.bitrixOutgoing ? <span className="pill good">включены</span> : <span className="pill">нет — новые дела забираются раз в 5 минут</span>}</span></div>
            <div><span>UIS, Call API</span><span>{env.uis ? <span className="pill good">ключ задан</span> : <span className="pill bad">не задан UIS_ACCESS_TOKEN в .env</span>}</span></div>
            <div><span>UIS, уведомления о звонках</span><span>{env.uisHook ? <span className="pill good">включены</span> : <span className="pill">не задан UIS_HOOK_KEY</span>}</span></div>
          </div>
        </section>
        {env.bitrix && <BitrixCheck />}
        <SourceSection data={data} onSaved={reload} />
        <CardFieldsSection data={data} onSaved={reload} />
        <LeadSection data={data} onSaved={reload} />
        <QueueUisSection data={data} onSaved={reload} />
        <SmsSection data={data} onSaved={reload} />
      </div>
    </>
  );
}

function BitrixCheck() {
  const { data } = useLoad(() => api<{ ok: boolean; user?: string; admin?: boolean; error?: string }>('/api/bitrix/check'), []);
  if (!data) return null;
  return data.ok
    ? <div className="alert good">Вебхук работает от имени: {data.user}{data.admin ? ' (администратор портала)' : ''}</div>
    : <div className="alert bad">Битрикс24 не отвечает на вебхук: {data.error}</div>;
}

function Section({ title, children, onSave, busy, extra }: { title: string; children: ReactNode; onSave: () => void; busy: boolean; extra?: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-h"><span className="label">{title}</span>{extra}</div>
      <div className="panel-b stack">{children}</div>
      <div className="foot"><button className="btn primary" disabled={busy} onClick={onSave}>Сохранить</button></div>
    </section>
  );
}

function useSaver<K extends keyof Settings>(key: K, initial: Settings[K], onSaved: () => void) {
  const toast = useToast();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(initial), [initial]);
  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/settings/${key}`, { method: 'PUT', body: value });
      toast('Настройки сохранены');
      onSaved();
    } catch (e) {
      toast(errorText(e), true);
    }
    setBusy(false);
  };
  return { value, setValue, save, busy };
}

function SourceSection({ data, onSaved }: { data: SettingsResponse; onSaved: () => void }) {
  const toast = useToast();
  const { value: s, setValue, save, busy } = useSaver('source', data.settings.source, onSaved);
  const set = (p: Partial<Settings['source']>) => setValue({ ...s, ...p });
  const on = data.env.bitrix;
  const users = useLoad(list<Opt & { position: string }>('/api/bitrix/users', on), [on]);
  const cats = useLoad(list<Opt>('/api/bitrix/categories', on), [on]);
  const stages = useLoad(list<Opt>(`/api/bitrix/stages?categoryId=${s.categoryId ?? 0}`, on), [on, s.categoryId]);
  const surveys = useLoad(() => api<{ items: { id: number; name: string; activeVersion: number | null; archived: boolean }[] }>('/api/surveys'), []);
  const [recent, setRecent] = useState<{ id: number; subject: string; providerId: string; providerTypeId: string; dealId: number; completed: boolean }[] | null>(null);
  const st = data.settings.syncState;

  const findRecent = async () => {
    try {
      const r = await api<{ items: NonNullable<typeof recent> }>(`/api/bitrix/recent-activities${s.responsibleIds[0] ? `?responsibleId=${s.responsibleIds[0]}` : ''}`);
      setRecent(r.items);
    } catch (e) {
      toast(errorText(e), true);
    }
  };
  const syncNow = async () => {
    try {
      const r = await api<{ imported: number; skipped: number }>('/api/sync', { body: {} });
      toast(`Загружено новых клиентов: ${r.imported}`);
      onSaved();
    } catch (e) {
      toast(errorText(e), true);
    }
  };

  return (
    <Section title="Какие сделки попадают в обзвон" onSave={save} busy={busy} extra={<button className="btn sm" disabled={!on || !s.enabled} onClick={syncNow}>Проверить сейчас</button>}>
      <p className="muted small" style={{ margin: 0 }}>
        Клиент появляется в очереди, когда в его сделке создают дело выбранного типа на сотрудника контроля качества.
        Последняя проверка: {fmtDateTime(st.lastRunAt)} · загружено всего: {st.imported}
        {st.lastError && <span className="err"> · ошибка: {st.lastError}</span>}
      </p>
      <label className="check"><input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} /><span><b>Загружать клиентов из Битрикс24</b></span></label>
      <Field label="Ответственный за дело — сотрудник контроля качества в Битрикс24">
        <select multiple value={s.responsibleIds.map(String)} onChange={(e) => set({ responsibleIds: [...e.target.selectedOptions].map((o) => Number(o.value)) })} style={{ minHeight: 110 }}>
          {users.data?.items.map((u) => <option key={u.id} value={u.id}>{u.name}{u.position ? ` · ${u.position}` : ''}</option>)}
        </select>
      </Field>
      <div className="grid3">
        <Field label="Тип дела (PROVIDER_ID)"><input className="mono" value={s.providerId} onChange={(e) => set({ providerId: e.target.value.trim() })} placeholder="CRM_TODO" /></Field>
        <Field label="Подтип (PROVIDER_TYPE_ID), необязательно"><input className="mono" value={s.providerTypeId} onChange={(e) => set({ providerTypeId: e.target.value.trim() })} /></Field>
        <Field label="Тема дела содержит"><input value={s.subjectContains} onChange={(e) => set({ subjectContains: e.target.value })} placeholder="Опрос ОКК" /></Field>
      </div>
      <div>
        <button className="btn sm" disabled={!on} onClick={findRecent}>Показать последние дела {s.responsibleIds.length ? 'выбранного сотрудника' : 'по сделкам'}</button>
        {recent && (
          <div className="tbl" style={{ marginTop: 8 }}><table>
            <thead><tr><th>Дело</th><th>Тема</th><th>Тип</th><th>Сделка</th><th /></tr></thead>
            <tbody>{recent.map((a) => (
              <tr key={a.id}>
                <td className="mono">#{a.id}{a.completed && <span className="muted"> · закрыто</span>}</td><td>{a.subject}</td>
                <td className="mono small">{a.providerId}{a.providerTypeId ? ` / ${a.providerTypeId}` : ''}</td><td className="mono">#{a.dealId}</td>
                <td><button className="btn sm" onClick={() => set({ providerId: a.providerId, providerTypeId: a.providerTypeId && a.providerTypeId !== a.providerId ? a.providerTypeId : '' })}>Это тип триггера</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <div className="grid3">
        <Field label="Воронка">
          <select value={s.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value === '' ? null : Number(e.target.value), stageIds: [] })}>
            <option value="">Любая</option>
            {cats.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Стадии сделки (пусто — любые)">
          <select multiple value={s.stageIds} onChange={(e) => set({ stageIds: [...e.target.selectedOptions].map((o) => o.value) })} style={{ minHeight: 90 }}>
            {stages.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Брать дела, созданные с"><input type="date" value={s.sinceDate} onChange={(e) => set({ sinceDate: e.target.value })} /></Field>
      </div>
      <div className="grid2">
        <Field label="Анкета для новых клиентов">
          <select value={s.surveyId ?? ''} onChange={(e) => set({ surveyId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Первая опубликованная</option>
            {surveys.data?.items.filter((x) => !x.archived && x.activeVersion).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
        <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={s.completeActivity} onChange={(e) => set({ completeActivity: e.target.checked })} /><span>Закрывать дело в Битрикс24, когда анкета заполнена или клиент отказался</span></label>
      </div>
      {data.env.bitrixOutgoing && <p className="muted small" style={{ margin: 0 }}>Исходящий вебхук Битрикс24 (событие «Добавление дела») — адрес: <span className="mono">{data.env.publicUrl}/hooks/bitrix</span></p>}
    </Section>
  );
}

function CardFieldsSection({ data, onSaved }: { data: SettingsResponse; onSaved: () => void }) {
  const { value, setValue, save, busy } = useSaver('cardFields', data.settings.cardFields, onSaved);
  const fields = useLoad(list<{ code: string; title: string; type: string }>('/api/bitrix/deal-fields', data.env.bitrix), [data.env.bitrix]);
  const [adding, setAdding] = useState('');
  const items = value.fields;
  const set = (f: typeof items) => setValue({ fields: f });
  return (
    <Section title="Поля сделки на карточке клиента" onSave={save} busy={busy}>
      <p className="muted small" style={{ margin: 0 }}>Эти поля сотрудник видит рядом с именем клиента. Значения берутся при загрузке клиента.</p>
      {items.map((f, i) => (
        <div key={f.code} className="opt" style={{ gridTemplateColumns: 'minmax(0,1fr) 220px auto auto auto' }}>
          <input aria-label="Подпись" value={f.label} onChange={(e) => set(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
          <span className="mono small muted" style={{ alignSelf: 'center' }}>{f.code}</span>
          <button className="btn sm ghost" disabled={i === 0} onClick={() => { const n = [...items]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; set(n); }} aria-label="Выше">↑</button>
          <button className="btn sm ghost" disabled={i === items.length - 1} onClick={() => { const n = [...items]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; set(n); }} aria-label="Ниже">↓</button>
          <button className="btn sm ghost" onClick={() => set(items.filter((_, j) => j !== i))} aria-label="Убрать">✕</button>
        </div>
      ))}
      <div className="row">
        <select aria-label="Поле сделки" value={adding} onChange={(e) => setAdding(e.target.value)} style={{ maxWidth: 420 }}>
          <option value="">— выберите поле сделки —</option>
          {fields.data?.items.filter((f) => !items.some((x) => x.code === f.code)).map((f) => <option key={f.code} value={f.code}>{f.title} ({f.code})</option>)}
        </select>
        <button className="btn sm" disabled={!adding} onClick={() => { const f = fields.data!.items.find((x) => x.code === adding)!; set([...items, { code: f.code, label: f.title }]); setAdding(''); }}>Добавить поле</button>
      </div>
    </Section>
  );
}

function LeadSection({ data, onSaved }: { data: SettingsResponse; onSaved: () => void }) {
  const { value: s, setValue, save, busy } = useSaver('lead', data.settings.lead, onSaved);
  const on = data.env.bitrix;
  const sources = useLoad(list<Opt>('/api/bitrix/sources', on), [on]);
  const users = useLoad(list<Opt>('/api/bitrix/users', on), [on]);
  const set = (p: Partial<Settings['lead']>) => setValue({ ...s, ...p });
  return (
    <Section title="Лид по рекомендации" onSave={save} busy={busy}>
      <div className="grid2">
        <Field label="Источник лида">
          <select value={s.sourceId} onChange={(e) => set({ sourceId: e.target.value })}>
            {!sources.data?.items.some((x) => x.id === s.sourceId) && <option value={s.sourceId}>{s.sourceId}</option>}
            {sources.data?.items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
        <Field label="Ответственный за лид">
          <select value={s.assignedById ?? ''} onChange={(e) => set({ assignedById: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Ответственный за сделку клиента</option>
            {users.data?.items.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        <Field label="Название лида. Подстановки: {клиент}, {рекомендуемый}, {сделка}"><input value={s.titleTemplate} onChange={(e) => set({ titleTemplate: e.target.value })} /></Field>
        <Field label="Поле лида для ID сделки рекомендателя (необязательно)"><input className="mono" value={s.refDealField} onChange={(e) => set({ refDealField: e.target.value.trim() })} placeholder="UF_CRM_..." /></Field>
      </div>
      <p className="muted small" style={{ margin: 0 }}>В комментарий лида всегда попадает ссылка на сделку клиента и пометка, если номер уже есть в CRM. Ответы анкеты в Битрикс24 не передаются.</p>
    </Section>
  );
}

function QueueUisSection({ data, onSaved }: { data: SettingsResponse; onSaved: () => void }) {
  const q = useSaver('queue', data.settings.queue, onSaved);
  const u = useSaver('uis', data.settings.uis, onSaved);
  return (
    <Section title="Перезвоны и телефония" onSave={async () => { await q.save(); await u.save(); }} busy={q.busy || u.busy}>
      <div className="grid2">
        <Field label="За сколько минут до времени перезвона клиент возвращается в очередь">
          <input type="number" min={0} max={240} value={q.value.callbackLeadMinutes} onChange={(e) => q.setValue({ callbackLeadMinutes: Number(e.target.value) })} style={{ width: 120 }} />
        </Field>
        <Field label="Виртуальный номер UIS для обзвона">
          <input className="mono" value={u.value.virtualNumber} onChange={(e) => u.setValue({ virtualNumber: e.target.value })} placeholder="74951234567" />
        </Field>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Звонок идёт так: UIS сначала звонит сотруднику на софтфон, после ответа — клиенту. Сотрудник видит виртуальный номер, номер клиента ему не показывается.
        ID сотрудника UIS указывается в карточке сотрудника. IP сервера нужно добавить в белый список UIS.
      </p>
    </Section>
  );
}

function SmsSection({ data, onSaved }: { data: SettingsResponse; onSaved: () => void }) {
  const { value: s, setValue, save, busy } = useSaver('sms', data.settings.sms, onSaved);
  const setProvider = (id: string, p: Partial<NonNullable<Settings['sms']['providers'][string]>>) => {
    const cur = s.providers[id] ?? { enabled: false, sender: '', credentials: {} };
    setValue({ ...s, providers: { ...s.providers, [id]: { ...cur, ...p } } });
  };
  const setTpl = (i: number, p: Partial<Settings['sms']['templates'][number]>) => setValue({ ...s, templates: s.templates.map((t, j) => (j === i ? { ...t, ...p } : t)) });
  return (
    <Section title="СМС из карточки клиента" onSave={save} busy={busy}>
      <div className="perm-grid">
        {data.smsProviders.map((p) => {
          const cfg = s.providers[p.id] ?? { enabled: false, sender: '', credentials: {} };
          return (
            <fieldset key={p.id}>
              <legend>{p.name}</legend>
              <label className="check"><input type="checkbox" checked={cfg.enabled} onChange={(e) => setProvider(p.id, { enabled: e.target.checked })} /><span>Подключён</span></label>
              {p.credentialFields.map((f) => (
                <Field key={f.key} label={f.label}>
                  <input className="mono" type={f.secret ? 'password' : 'text'} autoComplete="off" value={cfg.credentials[f.key] ?? ''} onChange={(e) => setProvider(p.id, { credentials: { ...cfg.credentials, [f.key]: e.target.value } })} />
                </Field>
              ))}
              <Field label="Имя отправителя"><input value={cfg.sender} onChange={(e) => setProvider(p.id, { sender: e.target.value })} /></Field>
            </fieldset>
          );
        })}
      </div>
      <div className="grid2">
        <Field label="Сервис по умолчанию">
          <select value={s.defaultProvider ?? ''} onChange={(e) => setValue({ ...s, defaultProvider: e.target.value || null })}>
            <option value="">—</option>
            {data.smsProviders.filter((p) => s.providers[p.id]?.enabled).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={s.allowEdit} onChange={(e) => setValue({ ...s, allowEdit: e.target.checked })} /><span>Сотрудник может править текст шаблона перед отправкой</span></label>
      </div>
      <div className="label">Шаблоны · подстановки {'{имя}'}, {'{имя отчество}'}, {'{фио}'}</div>
      {s.templates.map((t, i) => (
        <div key={t.id} className="grid2" style={{ gridTemplateColumns: '220px minmax(0,1fr) auto' }}>
          <input aria-label="Название шаблона" value={t.name} onChange={(e) => setTpl(i, { name: e.target.value })} />
          <textarea aria-label="Текст шаблона" rows={2} value={t.text} onChange={(e) => setTpl(i, { text: e.target.value })} />
          <button className="btn sm ghost" onClick={() => setValue({ ...s, templates: s.templates.filter((_, j) => j !== i) })} aria-label="Удалить шаблон">✕</button>
        </div>
      ))}
      <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => setValue({ ...s, templates: [...s.templates, { id: Math.random().toString(36).slice(2, 8), name: 'Партнёрская программа', text: '{имя}, спасибо за разговор! Условия партнёрской программы: ...' }] })}>Добавить шаблон</button>
    </Section>
  );
}
