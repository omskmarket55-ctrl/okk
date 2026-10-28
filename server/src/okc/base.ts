import { createHmac } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { encryptPhone, last2, normalizePhone } from '../auth/phone.js';

/** HMAC номера: по нему ищем дубли, сам номер в индексе не хранится. */
export const phoneHash = (phone: string, key: Buffer) => createHmac('sha256', key).update(`okc:${phone}`).digest('hex');

/** Номера из вставленного текста или файла: по одному в строке, разделители — запятая, точка с запятой, табуляция. */
export function parsePhones(text: string): { phones: string[]; invalid: number; total: number } {
  const chunks = text.split(/[\r\n,;\t]+/).map((s) => s.trim()).filter(Boolean);
  const phones: string[] = [];
  let invalid = 0;
  for (const c of chunks) {
    if (!/\d/.test(c)) continue; // заголовок столбца
    const p = normalizePhone(c);
    if (p) phones.push(p);
    else invalid++;
  }
  return { phones, invalid, total: phones.length + invalid };
}

/** Загрузка базы: каждый новый номер — карточка в общей базе. Номера, которые уже есть, пропускаются. */
export async function importBase(db: Db, userId: number, name: string, text: string, key: Buffer) {
  const { phones, invalid, total } = parsePhones(text);
  const unique = [...new Set(phones)];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query<{ id: number }>('INSERT INTO okc_batches (name, uploaded_by, total, invalid) VALUES ($1, $2, $3, $4) RETURNING id', [name, userId, total, invalid]);
    const batchId = b.rows[0].id;
    let added = 0;
    for (let i = 0; i < unique.length; i += 500) {
      const part = unique.slice(i, i + 500);
      const res = await client.query(
        `INSERT INTO okc_cards (batch_id, phone_enc, phone_last2, phone_hash)
         SELECT $1, x.enc, x.tail, x.hash FROM unnest($2::text[], $3::text[], $4::text[]) AS x(enc, tail, hash)
         ON CONFLICT (phone_hash) DO NOTHING`,
        [batchId, part.map((p) => encryptPhone(p, key)), part.map(last2), part.map((p) => phoneHash(p, key))],
      );
      added += res.rowCount ?? 0;
    }
    const duplicates = phones.length - added;
    await client.query('UPDATE okc_batches SET added = $2, duplicates = $3 WHERE id = $1', [batchId, added, duplicates]);
    await client.query('COMMIT');
    return { batchId, total, added, duplicates, invalid };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
