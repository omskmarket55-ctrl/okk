import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/pool.js';
import { getSetting, setSetting, type SourceSettings } from '../db/settings.js';
import { encryptPhone, last2, normalizePhone } from '../auth/phone.js';
import { BitrixError, type BitrixClient } from './client.js';
import { contactName, contactPhone, type DealDirectory } from './deals.js';

export interface Activity {
  ID: string;
  OWNER_ID: string;
  OWNER_TYPE_ID: string;
  SUBJECT?: string;
  RESPONSIBLE_ID?: string;
  PROVIDER_ID?: string;
  PROVIDER_TYPE_ID?: string;
  COMPLETED?: string;
}

/** Фильтр crm.activity.list по настройкам источника: открытые дела по сделкам после курсора. */
export function activityFilter(s: SourceSettings, afterId: number): Record<string, unknown> {
  const filter: Record<string, unknown> = { OWNER_TYPE_ID: 2, COMPLETED: 'N', '>ID': afterId };
  if (s.providerId) filter.PROVIDER_ID = s.providerId;
  if (s.providerTypeId) filter.PROVIDER_TYPE_ID = s.providerTypeId;
  if (s.responsibleIds.length) filter.RESPONSIBLE_ID = s.responsibleIds;
  if (s.sinceDate) filter['>=CREATED'] = `${s.sinceDate}T00:00:00`;
  return filter;
}

/** Подходит ли дело под тему, а сделка — под воронку и стадию. */
export function matchesSubject(s: SourceSettings, a: Activity): boolean {
  return !s.subjectContains.trim() || (a.SUBJECT ?? '').toLowerCase().includes(s.subjectContains.trim().toLowerCase());
}

export function matchesDeal(s: SourceSettings, deal: { CATEGORY_ID?: string | number; STAGE_ID?: string }): boolean {
  if (s.categoryId !== null && String(deal.CATEGORY_ID ?? '0') !== String(s.categoryId)) return false;
  if (s.stageIds.length && !s.stageIds.includes(String(deal.STAGE_ID ?? ''))) return false;
  return true;
}

async function defaultSurveyId(db: Db, s: SourceSettings): Promise<number | null> {
  if (s.surveyId) return s.surveyId;
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM surveys WHERE NOT archived AND active_version_id IS NOT NULL ORDER BY id LIMIT 1',
  );
  return rows[0]?.id ?? null;
}

/**
 * Забирает новые дела-триггеры из Битрикс24 и создаёт по ним карточки обзвона.
 * Курсор — ID последнего обработанного дела, поэтому повторный запуск ничего не дублирует.
 */
export async function syncActivities(db: Db, bx: BitrixClient, dir: DealDirectory, phoneKey: Buffer, log: FastifyBaseLogger) {
  const source = await getSetting(db, 'source');
  const state = await getSetting(db, 'syncState');
  if (!source.enabled || !bx.configured) return { imported: 0, skipped: 0 };

  let imported = 0;
  let skipped = 0;
  let cursor = state.lastActivityId;
  try {
    const activities = await bx.listAll<Activity>(
      'crm.activity.list',
      {
        filter: activityFilter(source, cursor),
        order: { ID: 'ASC' },
        select: ['ID', 'OWNER_ID', 'OWNER_TYPE_ID', 'SUBJECT', 'RESPONSIBLE_ID', 'PROVIDER_ID', 'PROVIDER_TYPE_ID', 'COMPLETED'],
      },
      500,
    );
    const wanted = (await getSetting(db, 'cardFields')).fields;
    const surveyId = await defaultSurveyId(db, source);

    for (const a of activities) {
      const done = await importActivity(db, bx, dir, phoneKey, source, a, wanted, surveyId);
      if (done) imported++;
      else skipped++;
      cursor = Math.max(cursor, Number(a.ID));
      await setSetting(db, 'syncState', { ...state, lastActivityId: cursor, lastRunAt: new Date().toISOString(), lastError: null, imported: state.imported + imported });
    }
    await setSetting(db, 'syncState', { ...state, lastActivityId: cursor, lastRunAt: new Date().toISOString(), lastError: null, imported: state.imported + imported });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Синхронизация с Битрикс24 не удалась');
    await setSetting(db, 'syncState', { ...state, lastActivityId: cursor, lastRunAt: new Date().toISOString(), lastError: message, imported: state.imported + imported });
  }
  return { imported, skipped };
}

async function importActivity(
  db: Db, bx: BitrixClient, dir: DealDirectory, phoneKey: Buffer, source: SourceSettings, a: Activity,
  wanted: { code: string; label: string }[], surveyId: number | null,
): Promise<boolean> {
  if (!matchesSubject(source, a)) return false;
  const exists = await db.query('SELECT 1 FROM cards WHERE activity_id = $1', [a.ID]);
  if (exists.rowCount) return false;

  let deal: Record<string, unknown>;
  try {
    deal = await bx.result<Record<string, unknown>>('crm.deal.get', { id: a.OWNER_ID });
  } catch (err) {
    // Сделку удалили или к ней нет доступа: пропускаем дело, чтобы не застрять на нём
    if (err instanceof BitrixError && err.code !== 'QUERY_LIMIT_EXCEEDED' && err.status !== 0 && err.status < 500) return false;
    throw err;
  }
  if (!matchesDeal(source, deal as { CATEGORY_ID?: string; STAGE_ID?: string })) return false;

  // Клиент уже в обзвоне по этой сделке — второе дело карточку не дублирует
  const open = await db.query<{ id: number }>("SELECT id FROM cards WHERE deal_id = $1 AND status IN ('queued', 'callback')", [a.OWNER_ID]);
  if (open.rows[0]) {
    await db.query("INSERT INTO card_events (card_id, type, data) VALUES ($1, 'duplicate_activity', $2)", [open.rows[0].id, { activityId: Number(a.ID) }]);
    return false;
  }

  let name = String(deal.TITLE ?? 'Без имени');
  let phone: string | null = null;
  const contactId = Number(deal.CONTACT_ID) || null;
  if (contactId) {
    const contact = await bx.result<Parameters<typeof contactName>[0]>('crm.contact.get', { id: contactId });
    name = contactName(contact);
    const raw = contactPhone(contact);
    phone = raw ? normalizePhone(raw) : null;
  }
  const fields = await dir.cardFields(deal, wanted);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO cards (deal_id, activity_id, contact_id, client_name, phone_enc, phone_last2, deal_title, deal_fields, survey_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [a.OWNER_ID, a.ID, contactId, name, phone ? encryptPhone(phone, phoneKey) : null, phone ? last2(phone) : null, deal.TITLE ?? null, JSON.stringify(fields), surveyId],
    );
    await client.query("INSERT INTO card_events (card_id, type, data) VALUES ($1, 'imported', $2)", [
      rows[0].id,
      { activityId: Number(a.ID), subject: a.SUBJECT ?? '', noPhone: !phone },
    ]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return true;
}
