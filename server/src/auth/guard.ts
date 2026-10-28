import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/pool.js';
import { findUserById, toCurrentUser, type CurrentUser } from '../db/users.js';
import type { Permission } from './permissions.js';
import { SESSION_COOKIE, verifySession } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: CurrentUser;
  }
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Сотрудник из cookie сессии. Заблокированный или сменивший пароль — не вошёл. */
export async function currentUser(req: FastifyRequest, db: Db, secret: string): Promise<CurrentUser | null> {
  if (req.user) return req.user;
  const s = verifySession(req.cookies[SESSION_COOKIE], secret);
  if (!s) return null;
  const row = await findUserById(db, s.userId);
  if (!row || !row.active || row.session_version !== s.ver) return null;
  req.user = toCurrentUser(row);
  return req.user;
}

export function makeGuard(db: Db, secret: string) {
  /** Требует вход и хотя бы одно из прав. Без прав в списке — только вход. */
  return async function need(req: FastifyRequest, ...anyOf: Permission[]): Promise<CurrentUser> {
    const user = await currentUser(req, db, secret);
    if (!user) throw new HttpError(401, 'unauthorized', 'Войдите в кабинет');
    if (anyOf.length && !anyOf.some((p) => user.permissions.has(p))) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
    return user;
  };
}

export type Guard = ReturnType<typeof makeGuard>;

export const can = (u: CurrentUser, p: Permission) => u.permissions.has(p);

export function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
  throw err;
}
