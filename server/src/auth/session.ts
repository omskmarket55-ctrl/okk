import { createHmac, timingSafeEqual } from 'node:crypto';

export interface Session {
  userId: number;
  /** Должна совпадать с users.session_version, иначе сессия отозвана */
  ver: number;
  /** Срок действия, миллисекунды Unix */
  exp: number;
}

export const SESSION_COOKIE = 'okk_session';
export const SESSION_TTL_MS = 12 * 3_600_000;

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const sign = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('base64url');

/** Подписанный токен сессии в cookie: живёт 12 часов, одна рабочая смена. */
export function issueSession(s: Omit<Session, 'exp'>, secret: string, ttlMs = SESSION_TTL_MS, now = Date.now()): string {
  const payload = b64(JSON.stringify({ ...s, exp: now + ttlMs }));
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token: string | undefined, secret: string, now = Date.now()): Session | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Session;
    return typeof s.userId === 'number' && typeof s.ver === 'number' && s.exp > now ? s : null;
  } catch {
    return null;
  }
}
