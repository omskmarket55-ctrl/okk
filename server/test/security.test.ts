import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decryptPhone, encryptPhone, maskPhone, normalizePhone } from '../src/auth/phone.js';
import { issueSession, verifySession } from '../src/auth/session.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { DEFAULT_ROLES, effectivePermissions } from '../src/auth/permissions.js';
import { maskSmsSettings, mergeSmsSettings } from '../src/routes/admin.js';
import { loginBlocked, recordFail } from '../src/routes/auth.js';

describe('телефоны', () => {
  it('нормализация российских номеров', () => {
    expect(normalizePhone('8 (913) 123-45-67')).toBe('79131234567');
    expect(normalizePhone('+7 913 123 45 67')).toBe('79131234567');
    expect(normalizePhone('9131234567')).toBe('79131234567');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('+1 202 555 0100')).toBeNull();
  });

  it('шифрование: расшифровывается тем же ключом, другим — нет', () => {
    const key = randomBytes(32);
    const enc = encryptPhone('79131234567', key);
    expect(enc).not.toContain('79131234567');
    expect(decryptPhone(enc, key)).toBe('79131234567');
    expect(() => decryptPhone(enc, randomBytes(32))).toThrow();
    expect(encryptPhone('79131234567', key)).not.toBe(enc);
  });

  it('маска показывает только две последние цифры', () => {
    expect(maskPhone('47')).toBe('+7 ••• ••• •• 47');
  });
});

describe('сессии и пароли', () => {
  it('подпись сессии проверяется', () => {
    const t = issueSession({ userId: 5, ver: 1 }, 'secret');
    expect(verifySession(t, 'secret')?.userId).toBe(5);
    expect(verifySession(t, 'other')).toBeNull();
    expect(verifySession(t.replace(/^./, 'x'), 'secret')).toBeNull();
    expect(verifySession(issueSession({ userId: 5, ver: 1 }, 'secret', 1000, 0), 'secret', 2000)).toBeNull();
  });

  it('пароль', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('блокировка после 5 неудачных входов', () => {
    const key = `1.2.3.4|test-${Math.random()}`;
    for (let i = 0; i < 4; i++) recordFail(key);
    expect(loginBlocked(key)).toBe(false);
    recordFail(key);
    expect(loginBlocked(key)).toBe(true);
    expect(loginBlocked(key, Date.now() + 11 * 60_000)).toBe(false);
  });
});

describe('права', () => {
  it('роль + добавленные − убранные', () => {
    const op = DEFAULT_ROLES.find((r) => r.name === 'Оператор')!.permissions;
    expect(effectivePermissions(op, [], []).has('recordings.own')).toBe(false);
    expect(effectivePermissions(op, ['recordings.own'], []).has('recordings.own')).toBe(true);
    expect(effectivePermissions(op, [], ['sms.send']).has('sms.send')).toBe(false);
    expect(effectivePermissions(op, ['nonsense'], []).size).toBe(op.length);
  });

  it('оператор по умолчанию не видит номера и не слушает записи', () => {
    const op = new Set(DEFAULT_ROLES.find((r) => r.name === 'Оператор')!.permissions);
    expect(op.has('phones.view')).toBe(false);
    expect(op.has('recordings.own')).toBe(false);
    expect(op.has('recordings.all')).toBe(false);
  });
});

describe('ключи СМС не уходят в браузер', () => {
  const saved = {
    defaultProvider: 'smsru' as const,
    providers: { smsru: { enabled: true, sender: 'UNO', credentials: { apiId: 'SECRET-KEY' } } },
    templates: [],
    allowEdit: true,
  };

  it('маскируются при чтении', () => {
    expect(JSON.stringify(maskSmsSettings(saved))).not.toContain('SECRET-KEY');
  });

  it('при сохранении маска заменяется старым значением', () => {
    const merged = mergeSmsSettings(maskSmsSettings(saved), saved);
    expect(merged.providers.smsru?.credentials.apiId).toBe('SECRET-KEY');
    const changed = mergeSmsSettings({ ...saved, providers: { smsru: { enabled: true, sender: 'UNO', credentials: { apiId: 'NEW' } } } }, saved);
    expect(changed.providers.smsru?.credentials.apiId).toBe('NEW');
  });
});
