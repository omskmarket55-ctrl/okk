import { useState } from 'react';
import { api, errorText, type Me } from '../api';
import { Field, Loading, Modal, useLoad, useToast } from '../components/ui';
import { fmtDateTime } from '../format';

interface User { id: number; login: string; name: string; roleId: number; roleName: string; active: boolean; grant: string[]; revoke: string[]; uisEmployeeId: number | null; lastLoginAt: string | null }
interface Roles { items: { id: number; name: string; permissions: string[] }[]; catalog: { title: string; items: { id: string; label: string }[] }[] }

export function UsersPage({ me }: { me: Me }) {
  const users = useLoad(() => api<{ items: User[] }>('/api/users'), []);
  const roles = useLoad(() => api<Roles>('/api/roles'), []);
  const [edit, setEdit] = useState<User | 'new' | null>(null);
  return (
    <>
      <div className="page-h">
        <div><div className="label">Доступ</div><h1>Сотрудники</h1></div>
        <button className="btn primary" onClick={() => setEdit('new')}>Добавить сотрудника</button>
      </div>
      <section className="panel">
        {!users.data || !roles.data ? <Loading error={users.error ?? roles.error} /> : (
          <div className="tbl"><table>
            <thead><tr><th>Сотрудник</th><th>Логин</th><th>Роль</th><th>Особые права</th><th>ID в UIS</th><th>Последний вход</th><th /></tr></thead>
            <tbody>{users.data.items.map((u) => (
              <tr key={u.id} style={u.active ? undefined : { opacity: 0.55 }}>
                <td><b>{u.name}</b>{!u.active && <span className="pill" style={{ marginLeft: 6 }}>заблокирован</span>}</td>
                <td className="mono">{u.login}</td>
                <td>{u.roleName}</td>
                <td className="small">{u.grant.length ? <span className="pill good">+{u.grant.length}</span> : null} {u.revoke.length ? <span className="pill bad">−{u.revoke.length}</span> : null}{!u.grant.length && !u.revoke.length && <span className="muted">как у роли</span>}</td>
                <td className="mono">{u.uisEmployeeId ?? '—'}</td>
                <td className="mono small">{fmtDateTime(u.lastLoginAt)}</td>
                <td><button className="btn sm" onClick={() => setEdit(u)}>Изменить</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {edit && roles.data && <UserDialog me={me} user={edit === 'new' ? null : edit} roles={roles.data} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); users.reload(); }} />}
    </>
  );
}

function UserDialog({ me, user, roles, onClose, onSaved }: { me: Me; user: User | null; roles: Roles; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [login, setLogin] = useState(user?.login ?? '');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState(user?.roleId ?? roles.items.find((r) => r.name === 'Оператор')?.id ?? roles.items[0].id);
  const [uis, setUis] = useState(user?.uisEmployeeId ? String(user.uisEmployeeId) : '');
  const [active, setActive] = useState(user?.active ?? true);
  const [grant, setGrant] = useState<string[]>(user?.grant ?? []);
  const [revoke, setRevoke] = useState<string[]>(user?.revoke ?? []);
  const [busy, setBusy] = useState(false);
  const rolePerms = roles.items.find((r) => r.id === roleId)?.permissions ?? [];

  // Галочка показывает итоговое право: роль + добавленные − убранные. Клик меняет исключение, а не роль.
  const has = (p: string) => (rolePerms.includes(p) || grant.includes(p)) && !revoke.includes(p);
  const toggle = (p: string) => {
    if (has(p)) {
      setGrant(grant.filter((x) => x !== p));
      if (rolePerms.includes(p)) setRevoke([...revoke, p]);
    } else {
      setRevoke(revoke.filter((x) => x !== p));
      if (!rolePerms.includes(p)) setGrant([...grant, p]);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const uisEmployeeId = uis.trim() ? Number(uis) : null;
      const cleanGrant = grant.filter((p) => !rolePerms.includes(p));
      const cleanRevoke = revoke.filter((p) => rolePerms.includes(p));
      if (user) {
        await api(`/api/users/${user.id}`, { method: 'PUT', body: { name, roleId, active, uisEmployeeId, grant: cleanGrant, revoke: cleanRevoke, ...(password ? { password } : {}) } });
      } else {
        const r = await api<{ id: number }>('/api/users', { body: { login, name, password, roleId, uisEmployeeId } });
        if (cleanGrant.length || cleanRevoke.length) await api(`/api/users/${r.id}`, { method: 'PUT', body: { grant: cleanGrant, revoke: cleanRevoke } });
      }
      toast('Сохранено');
      onSaved();
    } catch (e) {
      toast(errorText(e), true);
      setBusy(false);
    }
  };

  return (
    <Modal title={user ? user.name : 'Новый сотрудник'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Отмена</button>
      <button className="btn primary" disabled={busy || !name || (!user && (!login || password.length < 10))} onClick={save}>Сохранить</button>
    </>}>
      <div className="grid2">
        <Field label="Имя и фамилия"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Логин"><input value={login} disabled={Boolean(user)} onChange={(e) => setLogin(e.target.value)} className="mono" /></Field>
        <Field label={user ? 'Новый пароль (пусто — не менять)' : 'Пароль, не короче 10 символов'}><input type="text" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mono" /></Field>
        <Field label="ID сотрудника в UIS"><input value={uis} onChange={(e) => setUis(e.target.value.replace(/\D/g, ''))} className="mono" placeholder="для звонков из браузера" /></Field>
      </div>
      <Field label="Роль">
        <select value={roleId} onChange={(e) => { setRoleId(Number(e.target.value)); setGrant([]); setRevoke([]); }}>
          {roles.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>
      {user && user.id !== me.id && <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /><span>Доступ в кабинет открыт</span></label>}
      <details>
        <summary style={{ cursor: 'pointer' }}>Права сверх роли {grant.length + revoke.length ? `(изменено: ${grant.length + revoke.length})` : ''}</summary>
        <div className="stack" style={{ marginTop: 10, gap: 10 }}>
          {roles.catalog.map((g) => (
            <div key={g.title}>
              <div className="label" style={{ marginBottom: 4 }}>{g.title}</div>
              {g.items.map((p) => (
                <label key={p.id} className="check small">
                  <input type="checkbox" checked={has(p.id)} onChange={() => toggle(p.id)} />
                  <span>{p.label}{grant.includes(p.id) && <span className="pill good" style={{ marginLeft: 6 }}>добавлено</span>}{revoke.includes(p.id) && <span className="pill bad" style={{ marginLeft: 6 }}>убрано</span>}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      </details>
    </Modal>
  );
}
