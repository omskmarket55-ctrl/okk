import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/pool.js';
import { getSetting, type OkcSettings } from '../db/settings.js';
import { decryptPhone } from '../auth/phone.js';
import type { BitrixClient } from '../bitrix/client.js';
import { okcEvent, MEETING_REGIONS, MEETING_TYPES, type MeetingRegion, type MeetingType } from './service.js';
import { localDateTime } from './time.js';

export interface MeetingDealInput {
  clientName: string;
  phone: string;
  comment: string;
  at: Date;
  type: MeetingType;
  region: MeetingRegion;
  contactId: number;
}

/** Поля новой сделки в воронке ОКЦ. Чистая функция — проверяется тестом. */
export function buildMeetingDeal(s: OkcSettings, m: MeetingDealInput, operatorName: string): Record<string, unknown> {
  const b = s.bitrix;
  const fields: Record<string, unknown> = {
    TITLE: `Встреча (${MEETING_TYPES[m.type]}): ${m.clientName}`,
    CONTACT_ID: m.contactId,
    COMMENTS: m.comment,
    SOURCE_DESCRIPTION: `ОКЦ, оператор ${operatorName}`,
  };
  if (b.categoryId !== null) fields.CATEGORY_ID = b.categoryId;
  if (b.stageMeeting) fields.STAGE_ID = b.stageMeeting;
  if (b.assignedById) fields.ASSIGNED_BY_ID = b.assignedById;
  if (b.meetingAtField) fields[b.meetingAtField] = m.at.toISOString();
  if (b.meetingTypeField) fields[b.meetingTypeField] = MEETING_TYPES[m.type];
  if (b.regionField) fields[b.regionField] = MEETING_REGIONS[m.region];
  return fields;
}

/** Город и область — календарь «Встречи ОП», не Пермский край — «Встречи ОУП». */
export const calendarFor = (s: OkcSettings, region: MeetingRegion) => (region === 'outside' ? s.bitrix.calendarOup : s.bitrix.calendarOp);

/**
 * После записи на встречу: контакт (или найденный по номеру), сделка в стадии «Встреча назначена», событие в календаре.
 * Ошибка не отменяет встречу в кабинете: она записывается в карточку, супервайзер отправляет повторно.
 */
export async function pushMeeting(db: Db, bx: BitrixClient, phoneKey: Buffer, tz: string, cardId: number, log: FastifyBaseLogger) {
  const s = await getSetting(db, 'okc');
  const { rows } = await db.query<{ phone_enc: string; client_name: string; meeting_at: Date; meeting_type: MeetingType; meeting_region: MeetingRegion; bitrix_deal_id: string | null; operator: string; comment: string | null }>(
    `SELECT c.phone_enc, c.client_name, c.meeting_at, c.meeting_type, c.meeting_region, c.bitrix_deal_id, u.name AS operator,
            (SELECT e.data->>'text' FROM okc_events e WHERE e.card_id = c.id AND e.type = 'comment' ORDER BY e.id DESC LIMIT 1) AS comment
       FROM okc_cards c JOIN users u ON u.id = c.meeting_by WHERE c.id = $1 AND c.status = 'meeting'`,
    [cardId],
  );
  const c = rows[0];
  if (!c) return { ok: false, error: 'Встреча по карточке не назначена' };
  if (c.bitrix_deal_id) return { ok: true, dealId: Number(c.bitrix_deal_id) };
  try {
    if (!bx.configured) throw new Error('Битрикс24 не подключён: сделка создастся после подключения кнопкой «Отправить в Битрикс24»');
    const phone = `+${decryptPhone(c.phone_enc, phoneKey)}`;
    const dup = await bx.result<{ CONTACT?: number[] }>('crm.duplicate.findbycomm', { entity_type: 'CONTACT', type: 'PHONE', values: [phone] }).catch(() => ({}) as { CONTACT?: number[] });
    const contactId = dup.CONTACT?.[0]
      ?? Number(await bx.result<number>('crm.contact.add', { fields: { NAME: c.client_name, PHONE: [{ VALUE: phone, VALUE_TYPE: 'MOBILE' }], SOURCE_DESCRIPTION: 'ОКЦ' } }));
    const input = { clientName: c.client_name, phone, comment: c.comment ?? '', at: c.meeting_at, type: c.meeting_type, region: c.meeting_region, contactId };
    const dealId = Number(await bx.result<number>('crm.deal.add', { fields: buildMeetingDeal(s, input, c.operator) }));
    await db.query('UPDATE okc_cards SET bitrix_deal_id = $2, bitrix_error = NULL WHERE id = $1', [cardId, dealId]);
    await okcEvent(db, cardId, 'deal_created', null, { dealId });

    const cal = calendarFor(s, c.meeting_region);
    if (cal.sectionId && cal.ownerId) {
      try {
        const end = new Date(c.meeting_at.getTime() + s.bitrix.meetingMinutes * 60_000);
        const eventId = Number(await bx.result<number>('calendar.event.add', {
          type: cal.type, ownerId: cal.ownerId, section: cal.sectionId,
          name: `${MEETING_TYPES[c.meeting_type]} встреча: ${c.client_name}`,
          from: localDateTime(tz, c.meeting_at), to: localDateTime(tz, end), timezone_from: tz, timezone_to: tz,
          description: [`${MEETING_REGIONS[c.meeting_region]}. Телефон: ${phone}`, `Сделка #${dealId}`, c.comment ?? ''].filter(Boolean).join('\n'),
        }));
        await db.query('UPDATE okc_cards SET bitrix_event_id = $2 WHERE id = $1', [cardId, eventId]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await db.query('UPDATE okc_cards SET bitrix_error = $2 WHERE id = $1', [cardId, `Сделка создана, событие календаря — нет: ${message}`]);
      }
    }
    return { ok: true, dealId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, cardId }, 'Сделка ОКЦ не создана');
    await db.query('UPDATE okc_cards SET bitrix_error = $2 WHERE id = $1', [cardId, message]);
    await okcEvent(db, cardId, 'deal_error', null, { error: message });
    return { ok: false, error: message };
  }
}

/**
 * Стадии сделок ОКЦ: «Встреча состоялась» — статус и бонус оператору, «не состоялась» — карточка
 * снова в обзвоне и закреплена за оператором. Проверяются только сделки со статусом «Назначена встреча».
 */
export async function syncMeetingStages(db: Db, bx: BitrixClient, log: FastifyBaseLogger) {
  const s = await getSetting(db, 'okc');
  if (!bx.configured || (!s.bitrix.stagesDone.length && !s.bitrix.stagesFailed.length)) return { done: 0, failed: 0 };
  const { rows } = await db.query<{ id: number; bitrix_deal_id: string }>("SELECT id, bitrix_deal_id FROM okc_cards WHERE status = 'meeting' AND bitrix_deal_id IS NOT NULL");
  let done = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    let deals: { ID: string; STAGE_ID: string }[];
    try {
      deals = await bx.listAll<{ ID: string; STAGE_ID: string }>('crm.deal.list', { filter: { ID: chunk.map((r) => r.bitrix_deal_id) }, select: ['ID', 'STAGE_ID'] }, 50);
    } catch (err) {
      log.warn({ err }, 'Не удалось проверить стадии сделок ОКЦ');
      return { done, failed };
    }
    const stage = new Map(deals.map((d) => [String(d.ID), d.STAGE_ID]));
    for (const r of chunk) {
      const st = stage.get(String(r.bitrix_deal_id));
      if (!st) continue;
      if (s.bitrix.stagesDone.includes(st)) {
        if (await markMeetingDone(db, r.id, s)) done++;
      } else if (s.bitrix.stagesFailed.includes(st)) {
        if (await markMeetingFailed(db, r.id, s)) failed++;
      }
    }
  }
  return { done, failed };
}

/** Встреча состоялась: статус и начисление бонуса по стоимости встречи на этот момент. */
export async function markMeetingDone(db: Db, cardId: number, s: OkcSettings): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ meeting_by: number; meeting_type: MeetingType }>(
      "UPDATE okc_cards SET status = 'meeting_done', updated_at = now() WHERE id = $1 AND status = 'meeting' RETURNING meeting_by, meeting_type",
      [cardId],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return false;
    }
    const amount = rows[0].meeting_type === 'office' ? s.bonusOffice : s.bonusDks;
    await client.query(
      'INSERT INTO okc_bonus_accruals (user_id, card_id, meeting_type, amount) VALUES ($1, $2, $3, $4) ON CONFLICT (card_id) DO NOTHING',
      [rows[0].meeting_by, cardId, rows[0].meeting_type, amount],
    );
    await client.query("UPDATE okc_tasks SET done_at = now() WHERE card_id = $1 AND done_at IS NULL", [cardId]);
    await okcEvent(client, cardId, 'meeting_done', null, { operatorId: rows[0].meeting_by, bonus: amount });
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Встреча не состоялась: карточка снова в обзвоне, закреплена за оператором, который назначал встречу. */
export async function markMeetingFailed(db: Db, cardId: number, s: OkcSettings): Promise<boolean> {
  const { rows } = await db.query<{ meeting_by: number }>(
    `UPDATE okc_cards SET status = 'meeting_failed', owner_id = meeting_by, pin_kind = 'meeting_failed',
            pin_until = now() + make_interval(days => $2), available_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'meeting' RETURNING meeting_by`,
    [cardId, s.pinDays],
  );
  if (!rows[0]) return false;
  await db.query("UPDATE okc_tasks SET done_at = now() WHERE card_id = $1 AND done_at IS NULL", [cardId]);
  await okcEvent(db, cardId, 'meeting_failed', null, { operatorId: rows[0].meeting_by });
  return true;
}
