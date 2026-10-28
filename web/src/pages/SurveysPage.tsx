import { useState } from 'react';
import { api, errorText, type Me } from '../api';
import { go } from '../route';
import { Field, Loading, Modal, useLoad, useToast } from '../components/ui';
import { fmtDateTime } from '../format';

interface Row { id: number; name: string; archived: boolean; activeVersion: number | null; publishedAt: string | null; responses: number; hasDraft: boolean }

export function SurveysPage({ me }: { me: Me }) {
  const toast = useToast();
  const { data, error } = useLoad(() => api<{ items: Row[] }>('/api/surveys'), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [starter, setStarter] = useState(true);
  const create = async () => {
    try {
      const r = await api<{ id: number }>('/api/surveys', { body: { name, starter } });
      go({ page: 'survey', id: r.id });
    } catch (e) {
      toast(errorText(e), true);
    }
  };
  return (
    <>
      <div className="page-h">
        <div><div className="label">Скрипт звонка</div><h1>Конструктор анкет</h1></div>
        {me.permissions.includes('surveys.edit') && <button className="btn primary" onClick={() => setCreating(true)}>Новая анкета</button>}
      </div>
      <section className="panel">
        {!data ? <Loading error={error} /> : (
          <div className="tbl"><table>
            <thead><tr><th>Анкета</th><th>Опубликована</th><th className="num">Ответов</th><th>Состояние</th></tr></thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s.id} className="click" onClick={() => go({ page: 'survey', id: s.id })}>
                  <td><b>{s.name}</b></td>
                  <td>{s.activeVersion ? `версия ${s.activeVersion} · ${fmtDateTime(s.publishedAt)}` : <span className="muted">не опубликована</span>}</td>
                  <td className="num">{s.responses}</td>
                  <td>{s.archived ? <span className="pill">В архиве</span> : s.hasDraft ? <span className="pill warn">Есть неопубликованные правки</span> : s.activeVersion ? <span className="pill good">Работает</span> : <span className="pill">Черновик</span>}</td>
                </tr>
              ))}
              {!data.items.length && <tr><td colSpan={4} className="muted">Анкет пока нет. Создайте первую — можно начать с готового шаблона NPS.</td></tr>}
            </tbody>
          </table></div>
        )}
      </section>
      {creating && (
        <Modal title="Новая анкета" onClose={() => setCreating(false)} footer={<>
          <button className="btn" onClick={() => setCreating(false)}>Отмена</button>
          <button className="btn primary" disabled={!name.trim()} onClick={create}>Создать</button>
        </>}>
          <Field label="Название"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="NPS после встречи" autoFocus /></Field>
          <label className="check"><input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} /><span>Начать с шаблона: оценка NPS, причины, партнёрская программа с перезвоном и рекомендацией</span></label>
        </Modal>
      )}
    </>
  );
}
