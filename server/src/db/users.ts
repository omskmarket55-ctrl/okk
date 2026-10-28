import type { Db } from './pool.js';
import { DEFAULT_ROLES, effectivePermissions, type Permission } from '../auth/permissions.js';
import { hashPassword } from '../auth/password.js';

export interface UserRow {
  id: number;
  login: string;
  name: string;
  password_hash: string;
  role_id: number;
  role_name: string;
  role_permissions: string[];
  grant_perms: string[];
  revoke_perms: string[];
  uis_employee_id: string | null;
  active: boolean;
  session_version: number;
  last_login_at: Date | null;
}

export interface CurrentUser {
  id: number;
  login: string;
  name: string;
  roleId: number;
  roleName: string;
  uisEmployeeId: number | null;
  permissions: Set<Permission>;
}

const SELECT = `SELECT u.*, r.name AS role_name, r.permissions AS role_permissions FROM users u JOIN roles r ON r.id = u.role_id`;

export async function findUserById(db: Db, id: number): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(`${SELECT} WHERE u.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function findUserByLogin(db: Db, login: string): Promise<UserRow | null> {
  const { rows } = await db.query<UserRow>(`${SELECT} WHERE lower(u.login) = lower($1)`, [login]);
  return rows[0] ?? null;
}

export async function listUsers(db: Db): Promise<UserRow[]> {
  return (await db.query<UserRow>(`${SELECT} ORDER BY u.active DESC, u.name`)).rows;
}

export function toCurrentUser(u: UserRow): CurrentUser {
  return {
    id: u.id,
    login: u.login,
    name: u.name,
    roleId: u.role_id,
    roleName: u.role_name,
    uisEmployeeId: u.uis_employee_id ? Number(u.uis_employee_id) : null,
    permissions: effectivePermissions(u.role_permissions, u.grant_perms, u.revoke_perms),
  };
}

/** Первый запуск: готовые роли и администратор из INITIAL_ADMIN_* (.env). */
export async function seedUsers(db: Db, admin: { login: string; password: string }): Promise<'created' | 'exists' | 'no_password'> {
  for (const r of DEFAULT_ROLES) {
    await db.query('INSERT INTO roles (name, permissions, system) VALUES ($1, $2, true) ON CONFLICT (name) DO NOTHING', [r.name, r.permissions]);
  }
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM users');
  if (Number(rows[0].n) > 0) return 'exists';
  if (!admin.password) return 'no_password';
  const role = await db.query<{ id: number }>("SELECT id FROM roles WHERE name = 'Администратор'");
  await db.query('INSERT INTO users (login, name, password_hash, role_id) VALUES ($1, $2, $3, $4)', [
    admin.login, 'Администратор', await hashPassword(admin.password), role.rows[0].id,
  ]);
  return 'created';
}

export async function audit(db: Db, userId: number | null, action: string, target: string | null, data: object = {}, ip?: string) {
  await db.query('INSERT INTO audit_log (user_id, action, target, data, ip) VALUES ($1, $2, $3, $4, $5)', [userId, action, target, data, ip ?? null]);
}
