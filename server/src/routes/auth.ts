import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { verifyPassword } from '../auth/password.js';
import { SESSION_COOKIE, SESSION_TTL_MS, issueSession } from '../auth/session.js';
import { currentUser } from '../auth/guard.js';
import { audit, findUserByLogin } from '../db/users.js';
import { ALL_PERMISSIONS } from '../auth/permissions.js';
import { SMS_PROVIDERS } from '../sms/providers.js';
import { getSetting } from '../db/settings.js';

/** Не больше 5 неудачных попыток входа за 10 минут на пару «IP + логин». */
const MAX_FAILS = 5;
const BLOCK_MS = 10 * 60_000;
const fails = new Map<string, { n: number; until: number }>();

export function loginBlocked(key: string, now = Date.now()) {
  const f = fails.get(key);
  return Boolean(f && f.n >= MAX_FAILS && f.until > now);
}

export function recordFail(key: string, now = Date.now()) {
  const f = fails.get(key);
  if (!f || f.until < now) fails.set(key, { n: 1, until: now + BLOCK_MS });
  else f.n++;
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, config } = ctx;
  const secure = config.publicUrl.startsWith('https://');

  app.post('/api/login', async (req, reply) => {
    const { login, password } = (req.body ?? {}) as { login?: string; password?: string };
    if (!login || !password) return reply.code(400).send({ error: 'bad_request', message: 'Введите логин и пароль' });
    const key = `${req.ip}|${login.toLowerCase()}`;
    if (loginBlocked(key)) return reply.code(429).send({ error: 'blocked', message: 'Слишком много попыток. Попробуйте через 10 минут' });
    const user = await findUserByLogin(db, login);
    if (!user || !user.active || !(await verifyPassword(password, user.password_hash))) {
      recordFail(key);
      await audit(db, user?.id ?? null, 'login_failed', login, {}, req.ip);
      return reply.code(401).send({ error: 'bad_credentials', message: 'Неверный логин или пароль' });
    }
    fails.delete(key);
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    await audit(db, user.id, 'login', null, {}, req.ip);
    reply.setCookie(SESSION_COOKIE, issueSession({ userId: user.id, ver: user.session_version }, config.sessionSecret), {
      path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_TTL_MS / 1000,
    });
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    const user = await currentUser(req, db, config.sessionSecret);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    const sms = await getSetting(db, 'sms');
    return {
      id: user.id,
      login: user.login,
      name: user.name,
      roleName: user.roleName,
      permissions: ALL_PERMISSIONS.filter((p) => user.permissions.has(p)),
      integrations: {
        bitrix: ctx.bx.configured,
        uis: ctx.uis.configured && Boolean(user.uisEmployeeId),
        sms: Object.entries(sms.providers).filter(([, v]) => v?.enabled).map(([id]) => ({ id, name: SMS_PROVIDERS[id as keyof typeof SMS_PROVIDERS].name })),
      },
    };
  });
}
