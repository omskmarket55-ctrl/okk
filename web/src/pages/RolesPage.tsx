import { useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { Field, Loading, Modal, useLoad, useToast } from '../components/ui';

interface Role { id: number; name: string; permissions: string[]; system: boolean; users: number }
interface Roles { items: Role[]; catalog: { title: string; items: { id: string; label: string }[] }[] }

export function RolesPage() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api<Roles>('/api/roles'), []);
  const [selected, setSelected] = useState<number | null>(null);
  const [perms, setPerms] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const role = data?.items.find((r) => r.id === selected) ?? data?.items[0];

  useEffect(() => { if (role) { setSelected(role.id); setPerms(role.permissions); } }, [role?.id, data]);

  if (!data || !role) return <Loading error={error} />;
  const dirty = [...perms].sort().join() !== [...role.permissions].sort().join();
  const toggle = (p: string) => setPerms(perms.includes(p) ? perms.filter((x) => x !== p) : [...perms, p]);

  const save = async () => {
    try {
      await api(`/api/roles/${role.id}`, { method: 'PUT', body: { permissions: perms } });
      toast('Права роли сохранены. Сотрудники получат их при следующем действии');
      reload();
    } catch (e) {
      toast(errorText(e), true);
    }
  };
  const create = async () => {
    try {
      const r = await api<{ id: number }>('/api/roles', { body: { name: newName, permissions: role.permissions } });
      setCreating(false);
      setNewName('');
      setSelected(r.id);
      reload();
    } catch (e) {
      toast(errorText(e), true);
    }
  };
  const remove = async () => {
    try {
      await api(`/api/roles/${role.id}`, { method: 'DELETE' });
      setSelected(null);
      reload();
    } catch (e) {
      toast(errorText(e), true);
    }
  };

  return (
    <>
      <div className="page-h">
        <div><div className="label">Доступ</div><h1>Роли и права</h1></div>
        <button className="btn" onClick={() => setCreating(true)}>Новая роль</button>
      </div>
      <div className="chips" style={{ marginBottom: 16 }}>
        {data.items.map((r) => <button key={r.id} type="button" aria-pressed={r.id === role.id} onClick={() => setSelected(r.id)}>{r.name} · {r.users}</button>)}
      </div>
      <section className="panel">
        <div className="panel-h">
          <span><b>{role.name}</b> <span className="muted small">· сотрудников: {role.users}{role.system ? ' · готовая роль' : ''}</span></span>
          <div className="row">
            {!role.system && <button className="btn sm" onClick={remove} disabled={role.users > 0} title={role.users ? 'Роль назначена сотрудникам' : undefined}>Удалить роль</button>}
            <button className="btn primary sm" disabled={!dirty} onClick={save}>Сохранить</button>
          </div>
        </div>
        <div className="panel-b perm-grid">
          {data.catalog.map((g) => (
            <fieldset key={g.title}>
              <legend>{g.title}</legend>
              {g.items.map((p) => <label key={p.id} className="check"><input type="checkbox" checked={perms.includes(p.id)} onChange={() => toggle(p.id)} /><span>{p.label}</span></label>)}
            </fieldset>
          ))}
        </div>
      </section>
      <p className="muted small">Права проверяет сервер: без права «Видеть полный номер клиента» номер не передаётся в браузер вовсе. Отдельному сотруднику права можно добавить или убрать в разделе «Сотрудники».</p>
      {creating && (
        <Modal title="Новая роль" onClose={() => setCreating(false)} footer={<><button className="btn" onClick={() => setCreating(false)}>Отмена</button><button className="btn primary" disabled={!newName.trim()} onClick={create}>Создать</button></>}>
          <Field label="Название"><input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Контроль качества" autoFocus /></Field>
          <p className="muted small" style={{ margin: 0 }}>Права скопируются из роли «{role.name}», потом их можно изменить.</p>
        </Modal>
      )}
    </>
  );
}
