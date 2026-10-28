import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Номер в российском формате E.164 без плюса: 79131234567. Принимает 8 913…, +7 (913)…, 913….
 * Возвращает null, если это не похоже на российский мобильный или городской номер.
 */
export function normalizePhone(input: string): string | null {
  let d = input.replace(/\D/g, '');
  if (d.length === 10) d = `7${d}`;
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`;
  return /^7\d{10}$/.test(d) ? d : null;
}

export const last2 = (phone: string) => phone.slice(-2);

/** Маска для сотрудников без права видеть номер: +7 ••• ••• •• 47 */
export const maskPhone = (tail: string | null) => (tail ? `+7 ••• ••• •• ${tail}` : '—');

export const formatPhone = (p: string) => `+7 ${p.slice(1, 4)} ${p.slice(4, 7)}-${p.slice(7, 9)}-${p.slice(9, 11)}`;

/** Телефоны в базе зашифрованы AES-256-GCM: v1.iv.tag.шифротекст в base64url. */
export function encryptPhone(phone: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptPhone(enc: string, key: Buffer): string {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Неизвестный формат зашифрованного номера');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
