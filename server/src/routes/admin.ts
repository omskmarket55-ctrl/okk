import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../app.js';
import { HttpError } from '../auth/guard.js';
import { hashPassword, passwordProblem } from '../auth/password.js';
import { ALL_PERMISSIONS, PERMISSION_GROUPS, isPermission } from '../auth/permissions.js';
import { audit, listUsers } from '../db/users.js';
import { getSetting, setSetting, type SettingsMap, type SmsSettings } from '../db/settings.js';
import { SMS_PROVIDERS } from '../sms/providers.js';
import { normalizePhone } from '../auth/phone.js';

const idOf = (req: FastifyRequest) => Number((req.params as { id: string }).id);
const perms = (list: unknown) => (Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string' && isPermission(p)) : []);

/** Ключи сервисов СМС в браузер не отдаём: вместо значения — признак, что оно задано. */
const SECRET_MASK = '••••••';
export function maskSmsSettings(s: SmsSettings): SmsSettings {
  const providers: SmsSettings['providers'] = {};
  for (const [id, p] of Object.entries(s.providers)) {
    if (!p) continue;
    const fields = SMS_PROVIDERS[id as keyof typeof SMS_PROVIDERS].credentialFields;
    providers[id as keyof typeof providers] = {
      ...p,
      credentials: Object.fromEntries(Object.entries(p.credentials).map(([k, v]) => [k, fields.find((f) => f.key === k)?.secret && v ? SECRET_MASK : v])),
    };
  }
  return { ...s, providers };
}

/** Новые настройки СМС: замаскированные ключи заменяем сохранёнными. */
export function mergeSmsSettings(next: SmsSettings, prev: SmsSettings): SmsSettings {
  const providers: SmsSettings['providers'] = {};
  for (const [id, p] of Object.entries(next.providers ?? {})) {
    if (!p || !(id in SMS_PROVIDERS)) continue;
    const old = prev.providers[id as keyof typeof providers]?.credentials ?? {};
    providers[id as keyof typeof providers] = {
      enabled: Boolean(p.enabled),
      sender: String(p.sender ?? ''),
      credentials: Object.fromEntries(Object.entries(p.credentials ?? {}).map(([k, v]) => [k, v === SECRET_MASK ? (old[k] ?? '') : String(v)])),
    };
  }
  return {
    defaultProvider: next.defaultProvider && next.defaultProvider in SMS_PROVIDERS ? next.defaultProvider : null,
    providers,
    templates: (next.templates ?? []).map((t) => ({ id: String(t.id), name: String(t.name), text: String(t.text).slice(0, 670) })),
    allowEdit: Boolean(next.allowEdit),
  };
}

const EDITABLE = ['source', 'cardFields', 'lead', 'queue', 'uis', 'sms'] as const;
type EditableKey = (typeof EDITABLE)[number];

export async function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, need, bx } = ctx;

  // ——— Сотрудники
  app.get('/api/users', async (req) => {
    await need(req, 'users.manage', 'queue.assign', 'reports.all');
    const users = await listUsers(db);
    return {
      items: users.map((u) => ({
        id: u.id, login: u.login, name: u.name, roleId: u.role_id, roleName: u.role_name, active: u.active,
        grant: u.grant_perms, revoke: u.revoke_perms, uisEmployeeId: u.uis_employee_id ? Number(u.uis_employee_id) : null,
        lastLoginAt: u.last_login_at,
      })),
    };
  });

  app.post('/api/users', async (req) => {
    const me = await need(req, 'users.manage');
    const b = (req.body ?? {}) as { login?: string; name?: string; password?: string; roleId?: number; uisEmployeeId?: number | null };
    if (!b.login?.trim() || !/^[a-zA-Z0-9._-]{3,40}$/.test(b.login.trim())) throw new HttpError(400, 'bad_login', 'Логин: 3–40 латинских букв, цифр, точек или дефисов');
    if (!b.name?.trim()) throw new HttpError(400, 'bad_name', 'Введите имя сотрудника');
    const problem = passwordProblem(b.password ?? '');
    if (problem) throw new HttpError(400, 'bad_password', problem);
    try {
      const { rows } = await db.query<{ id: number }>(
        'INSERT INTO users (login, name, password_hash, role_id, uis_employee_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [b.login.trim(), b.name.trim(), await hashPassword(b.password!), b.roleId, b.uisEmployeeId || null],
      );
      await audit(db, me.id, 'user_create', `user:${rows[0].id}`, { login: b.login, roleId: b.roleId }, req.ip);
      return { id: rows[0].id };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'login_taken', 'Такой логин уже есть');
      throw err;
    }
  });

  app.put('/api/users/:id', async (req) => {
    const me = await need(req, 'users.manage');
    const id = idOf(req);
    const b = (req.body ?? {}) as { name?: string; roleId?: number; active?: boolean; grant?: string[]; revoke?: string[]; uisEmployeeId?: number | null; password?: string };
    if (id === me.id && b.active === false) throw new HttpError(400, 'self', 'Нельзя заблокировать самого себя');
    if (b.password) {
      const problem = passwordProblem(b.password);
      if (problem) throw new HttpError(400, 'bad_password', problem);
    }
    const { rowCount } = await db.query(
      `UPDATE users SET name = COALESCE($2, name), role_id = COALESCE($3, role_id), active = COALESCE($4, active),
              grant_perms = COALESCE($5, grant_perms), revoke_perms = COALESCE($6, revoke_perms),
              uis_employee_id = CASE WHEN $7::boolean THEN $8 ELSE uis_employee_id END,
              password_hash = COALESCE($9, password_hash),
              session_version = session_version + CASE WHEN $9 IS NOT NULL OR $4 = false THEN 1 ELSE 0 END
        WHERE id = $1`,
      [id, b.name?.trim() || null, b.roleId ?? null, typeof b.active === 'boolean' ? b.active : null,
        b.grant ? perms(b.grant) : null, b.revoke ? perms(b.revoke) : null,
        'uisEmployeeId' in b, b.uisEmployeeId || null, b.password ? await hashPassword(b.password) : null],
    );
    if (!rowCount) throw new HttpError(404, 'not_found', 'Сотрудник не найден');
    const { password: _pw, ...logged } = b;
    await audit(db, me.id, 'user_update', `user:${id}`, { ...logged, passwordChanged: Boolean(b.password) }, req.ip);
    return { ok: true };
  });

  // ——— Роли
  app.get('/api/roles', async (req) => {
    await need(req, 'roles.manage', 'users.manage');
    const { rows } = await db.query(
      `SELECT r.id, r.name, r.permissions, r.system, (SELECT count(*) FROM users u WHERE u.role_id = r.id)::int AS users FROM roles r ORDER BY r.id`,
    );
    return { items: rows, catalog: PERMISSION_GROUPS.map((g) => ({ title: g.title, items: g.items.map(([id, label]) => ({ id, label })) })) };
  });

  app.post('/api/roles', async (req) => {
    const me = await need(req, 'roles.manage');
    const b = (req.body ?? {}) as { name?: string; permissions?: string[] };
    if (!b.name?.trim()) throw new HttpError(400, 'bad_name', 'Введите название роли');
    try {
      const { rows } = await db.query<{ id: number }>('INSERT INTO roles (name, permissions) VALUES ($1, $2) RETURNING id', [b.name.trim(), perms(b.permissions)]);
      await audit(db, me.id, 'role_create', `role:${rows[0].id}`, { name: b.name, permissions: perms(b.permissions) }, req.ip);
      return { id: rows[0].id };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'name_taken', 'Роль с таким названием уже есть');
      throw err;
    }
  });

  app.put('/api/roles/:id', async (req) => {
    const me = await need(req, 'roles.manage');
    const id = idOf(req);
    const b = (req.body ?? {}) as { name?: string; permissions?: string[] };
    const next = perms(b.permissions);
    // Защита от потери доступа: у роли администратора всегда остаётся управление ролями
    const { rows } = await db.query<{ name: string }>('SELECT name FROM roles WHERE id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'Роль не найдена');
    if (rows[0].name === 'Администратор' && (!next.includes('roles.manage') || !next.includes('users.manage'))) {
      throw new HttpError(400, 'admin_role', 'У роли «Администратор» нельзя убрать управление сотрудниками и ролями');
    }
    await db.query('UPDATE roles SET name = COALESCE($2, name), permissions = $3 WHERE id = $1', [id, rows[0].name === 'Администратор' ? null : b.name?.trim() || null, next]);
    await audit(db, me.id, 'role_update', `role:${id}`, { permissions: next }, req.ip);
    return { ok: true };
  });

  app.delete('/api/roles/:id', async (req) => {
    const me = await need(req, 'roles.manage');
    const id = idOf(req);
    const { rows } = await db.query<{ system: boolean; users: number }>(
      'SELECT system, (SELECT count(*) FROM users WHERE role_id = $1)::int AS users FROM roles WHERE id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'Роль не найдена');
    if (rows[0].system) throw new HttpError(400, 'system_role', 'Готовые роли удалить нельзя');
    if (rows[0].users) throw new HttpError(400, 'role_in_use', 'Роль назначена сотрудникам — сначала смените им роль');
    await db.query('DELETE FROM roles WHERE id = $1', [id]);
    await audit(db, me.id, 'role_delete', `role:${id}`, {}, req.ip);
    return { ok: true };
  });

  // ——— Настройки
  app.get('/api/settings', async (req) => {
    await need(req, 'integrations.manage');
    const out: Partial<SettingsMap> = {};
    for (const k of [...EDITABLE, 'syncState'] as const) (out as Record<string, unknown>)[k] = await getSetting(db, k);
    out.sms = maskSmsSettings(out.sms!);
    return {
      settings: out,
      env: {
        bitrix: bx.configured, bitrixPortal: bx.portalUrl, bitrixOutgoing: Boolean(ctx.config.bitrixOutgoingToken),
        uis: ctx.uis.configured, uisHook: Boolean(ctx.config.uisHookKey), publicUrl: ctx.config.publicUrl,
      },
      smsProviders: Object.values(SMS_PROVIDERS).map((p) => ({ id: p.id, name: p.name, credentialFields: p.credentialFields })),
      permissionsCount: ALL_PERMISSIONS.length,
    };
  });

  app.put('/api/settings/:key', async (req) => {
    const me = await need(req, 'integrations.manage');
    const key = (req.params as { key: string }).key as EditableKey;
    if (!EDITABLE.includes(key)) throw new HttpError(400, 'bad_key', 'Неизвестный раздел настроек');
    const prev = await getSetting(db, key);
    let value = { ...prev, ...(req.body as object) } as SettingsMap[EditableKey];
    if (key === 'sms') value = mergeSmsSettings(req.body as SmsSettings, prev as SmsSettings);
    if (key === 'uis') {
      const v = value as SettingsMap['uis'];
      const n = v.virtualNumber ? normalizePhone(v.virtualNumber) : '';
      if (v.virtualNumber && !n) throw new HttpError(400, 'bad_number', 'Виртуальный номер — 11 цифр, например 74951234567');
      value = { virtualNumber: n ?? '' };
    }
    if (key === 'queue') {
      const m = Number((value as SettingsMap['queue']).callbackLeadMinutes);
      if (!Number.isInteger(m) || m < 0 || m > 240) throw new HttpError(400, 'bad_minutes', 'Минуты до перезвона — от 0 до 240');
    }
    if (key === 'source') {
      const s = value as SettingsMap['source'];
      s.responsibleIds = (s.responsibleIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      s.stageIds = (s.stageIds ?? []).map(String);
      s.categoryId = s.categoryId === null || s.categoryId === undefined || (s.categoryId as unknown) === '' ? null : Number(s.categoryId);
    }
    await setSetting(db, key, value as never);
    await audit(db, me.id, 'settings_update', key, key === 'sms' ? { providers: Object.keys((value as SmsSettings).providers) } : value, req.ip);
    if (key === 'source') ctx.scheduler.triggerSync();
    return { ok: true };
  });

  app.post('/api/sync', async (req) => {
    await need(req, 'integrations.manage');
    return ctx.scheduler.syncNow();
  });

  // ——— Справочники Битрикс24 для настроек источника и полей карточки
  app.get('/api/bitrix/check', async (req) => {
    await need(req, 'integrations.manage');
    try {
      const p = await bx.result<{ NAME?: string; LAST_NAME?: string; ADMIN?: boolean }>('profile');
      return { ok: true, user: [p.NAME, p.LAST_NAME].filter(Boolean).join(' '), admin: Boolean(p.ADMIN) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get('/api/bitrix/deal-fields', async (req) => {
    await need(req, 'integrations.manage');
    const fields = await ctx.dir.dealFields();
    return { items: Object.entries(fields).map(([code, f]) => ({ code, title: f.title || code, type: f.type })) };
  });

  app.get('/api/bitrix/categories', async (req) => {
    await need(req, 'integrations.manage');
    const res = await bx.result<{ categories: { id: number; name: string }[] }>('crm.category.list', { entityTypeId: 2 });
    return { items: res.categories.map((c) => ({ id: c.id, name: c.name })) };
  });

  app.get('/api/bitrix/stages', async (req) => {
    await need(req, 'integrations.manage');
    const categoryId = Number((req.query as { categoryId?: string }).categoryId ?? 0);
    const entity = categoryId ? `DEAL_STAGE_${categoryId}` : 'DEAL_STAGE';
    const items = await bx.listAll<{ STATUS_ID: string; NAME: string }>('crm.status.list', { filter: { ENTITY_ID: entity }, order: { SORT: 'ASC' } });
    return { items: items.map((s) => ({ id: s.STATUS_ID, name: s.NAME })) };
  });

  app.get('/api/bitrix/users', async (req) => {
    await need(req, 'integrations.manage');
    const items = await bx.listAll<{ ID: string; NAME?: string; LAST_NAME?: string; WORK_POSITION?: string }>('user.get', { filter: { ACTIVE: true } }, 500);
    return { items: items.map((u) => ({ id: Number(u.ID), name: [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || `#${u.ID}`, position: u.WORK_POSITION ?? '' })) };
  });

  app.get('/api/bitrix/sources', async (req) => {
    await need(req, 'integrations.manage');
    const items = await bx.listAll<{ STATUS_ID: string; NAME: string }>('crm.status.list', { filter: { ENTITY_ID: 'SOURCE' } });
    return { items: items.map((s) => ({ id: s.STATUS_ID, name: s.NAME })) };
  });

  // Последние дела выбранных сотрудников: помогает найти, какого типа дело-триггер
  app.get('/api/bitrix/recent-activities', async (req) => {
    await need(req, 'integrations.manage');
    const q = req.query as { responsibleId?: string };
    const filter: Record<string, unknown> = { OWNER_TYPE_ID: 2 };
    if (q.responsibleId) filter.RESPONSIBLE_ID = Number(q.responsibleId);
    const res = await bx.call<{ ID: string; SUBJECT: string; PROVIDER_ID: string; PROVIDER_TYPE_ID: string; COMPLETED: string; OWNER_ID: string; CREATED: string }[]>(
      'crm.activity.list',
      { filter, order: { ID: 'DESC' }, select: ['ID', 'SUBJECT', 'PROVIDER_ID', 'PROVIDER_TYPE_ID', 'COMPLETED', 'OWNER_ID', 'CREATED'], start: 0 },
    );
    return { items: res.result.slice(0, 30).map((a) => ({ id: Number(a.ID), subject: a.SUBJECT, providerId: a.PROVIDER_ID, providerTypeId: a.PROVIDER_TYPE_ID, completed: a.COMPLETED === 'Y', dealId: Number(a.OWNER_ID), created: a.CREATED })) };
  });

  // ——— Журнал действий
  app.get('/api/audit', async (req) => {
    await need(req, 'audit.view');
    const q = req.query as { page?: string; action?: string };
    const page = Math.max(1, Number(q.page) || 1);
    const params: unknown[] = [];
    const where = q.action ? `WHERE a.action = $${params.push(q.action)}` : '';
    const { rows } = await db.query(
      `SELECT a.id, a.action, a.target, a.data, a.ip, a.created_at AS "createdAt", u.name AS "userName"
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${where} ORDER BY a.id DESC LIMIT 100 OFFSET ${(page - 1) * 100}`,
      params,
    );
    return { items: rows, page };
  });
}
