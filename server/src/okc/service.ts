import type { Db } from '../db/pool.js';
import type { CurrentUser } from '../db/users.js';
import type { OkcSettings } from '../db/settings.js';
import { HttpError, can } from '../auth/guard.js';
import { decryptPhone, maskPhone } from '../auth/phone.js';
import { reminderDue } from './time.js';

export type OperatorStatus = 'ready' | 'break' | 'offline';
export type OkcCardStatus = 'new' | 'later' | 'agreement' | 'refused' | 'meeting' | 'meeting_done' | 'meeting_failed';

export const OKC_STATUS_LABELS: Record<OkcCardStatus, string> = {
  new: 'В базе обзвона',
  later: 'Позвонить позднее',
  agreement: 'Есть договорённость',
  refused: 'Отказ',
  meeting: 'Назначена встреча',
  meeting_done: 'Встреча состоялась',
  meeting_failed: 'Встреча не состоялась',
};

export const MEETING_TYPES = { office: 'Офисная', dks: 'ДКС' } as const;
export const MEETING_REGIONS = { city: 'Город', region: 'Область', outside: 'Не Пермский край' } as const;
export type MeetingType = keyof typeof MEETING_TYPES;
export type MeetingRegion = keyof typeof MEETING_REGIONS;

/** Карточки, с которыми ещё звонят: только их можно выдать, открепить и вернуть в общую базу */
const WORKABLE = ['new', 'later', 'agreement', 'meeting_failed'];

const event = (db: Pick<Db, 'query'>, cardId: number, type: string, userId: number | null, data: object = {}) =>
  db.query('INSERT INTO okc_events (card_id, type, user_id, data) VALUES ($1, $2, $3, $4)', [cardId, type, userId, data]);

export { event as okcEvent };

// ——— Статус оператора

export async function operatorState(db: Db, userId: number) {
  const { rows } = await db.query<{ status: OperatorStatus; since: Date }>('SELECT status, since FROM okc_operator_state WHERE user_id = $1', [userId]);
  const breakToday = await db.query<{ s: string | null }>(
    `SELECT sum(extract(epoch FROM (COALESCE(ended_at, now()) - GREATEST(started_at, date_trunc('day', now())))))::int AS s
       FROM okc_status_log WHERE user_id = $1 AND status = 'break' AND COALESCE(ended_at, now()) > date_trunc('day', now())`,
    [userId],
  );
  return { status: rows[0]?.status ?? 'offline', since: rows[0]?.since ?? null, breakSecondsToday: Number(breakToday.rows[0].s ?? 0) };
}

/** Смена статуса. Не «Готов» — карточка с экрана возвращается туда, откуда её взяли. */
export async function setOperatorStatus(db: Db, userId: number, status: OperatorStatus) {
  const prev = await operatorState(db, userId);
  if (prev.status === status) return;
  await db.query('UPDATE okc_status_log SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL', [userId]);
  await db.query('INSERT INTO okc_status_log (user_id, status) VALUES ($1, $2)', [userId, status]);
  await db.query(
    `INSERT INTO okc_operator_state (user_id, status, since) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status, since = now()`,
    [userId, status],
  );
  if (status !== 'ready') await db.query('UPDATE okc_cards SET current_user_id = NULL, current_since = NULL WHERE current_user_id = $1', [userId]);
}

// ——— Выдача карточек

/**
 * Следующая карточка для оператора в статусе «Готов». Порядок: подошедшие договорённости, затем свои закреплённые
 * (позвонить позднее, встреча не состоялась), затем общая база по порядку загрузки.
 * Каждый «Готов» берёт по одной карточке, поэтому база делится между операторами поровну.
 * SKIP LOCKED: двое одновременно не получат одну карточку.
 */
export async function nextCard(db: Db, userId: number): Promise<number | null> {
  const state = await operatorState(db, userId);
  if (state.status !== 'ready') throw new HttpError(409, 'not_ready', 'Нажмите «Готов», чтобы получать карточки');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query<{ id: number }>('SELECT id FROM okc_cards WHERE current_user_id = $1', [userId]);
    if (cur.rows[0]) {
      await client.query('COMMIT');
      return cur.rows[0].id;
    }
    const { rows } = await client.query<{ id: number }>(
      `SELECT id FROM okc_cards
        WHERE current_user_id IS NULL AND available_at <= now()
          AND ((owner_id = $1 AND status IN ('new', 'later', 'agreement', 'meeting_failed'))
               OR (owner_id IS NULL AND status IN ('new', 'meeting_failed')))
        ORDER BY (owner_id IS NOT NULL) DESC, (status = 'agreement') DESC, available_at, id
        LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [userId],
    );
    const id = rows[0]?.id ?? null;
    if (id) {
      await client.query('UPDATE okc_cards SET current_user_id = $2, current_since = now(), updated_at = now() WHERE id = $1', [id, userId]);
      await event(client, id, 'offered', userId);
    }
    await client.query('COMMIT');
    return id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

interface CardRow {
  id: number;
  phone_enc: string;
  phone_last2: string;
  client_name: string | null;
  status: OkcCardStatus;
  owner_id: number | null;
  owner_name: string | null;
  pin_kind: string | null;
  pin_until: Date | null;
  available_at: Date;
  callback_at: Date | null;
  current_user_id: number | null;
  attempts: number;
  refuse_reason_id: number | null;
  refuse_reason: string | null;
  meeting_at: Date | null;
  meeting_type: MeetingType | null;
  meeting_region: MeetingRegion | null;
  meeting_by: number | null;
  meeting_by_name: string | null;
  bitrix_deal_id: string | null;
  bitrix_error: string | null;
  batch_name: string | null;
  created_at: Date;
}

export async function loadOkcCard(db: Db, id: number): Promise<CardRow> {
  const { rows } = await db.query<CardRow>(
    `SELECT c.*, o.name AS owner_name, m.name AS meeting_by_name, r.name AS refuse_reason, b.name AS batch_name
       FROM okc_cards c LEFT JOIN users o ON o.id = c.owner_id LEFT JOIN users m ON m.id = c.meeting_by
       LEFT JOIN okc_refuse_reasons r ON r.id = c.refuse_reason_id LEFT JOIN okc_batches b ON b.id = c.batch_id
      WHERE c.id = $1`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Карточка не найдена');
  return rows[0];
}

/** Действовать по карточке может тот, у кого она на экране, или за кем она закреплена. */
function assertCanAct(c: CardRow, user: CurrentUser) {
  if (c.current_user_id === user.id || c.owner_id === user.id || c.meeting_by === user.id) return;
  throw new HttpError(403, 'not_yours', 'Эта карточка сейчас не у вас');
}

async function assertCanSee(db: Db, c: CardRow, user: CurrentUser) {
  if (can(user, 'okc.base') || c.current_user_id === user.id || c.owner_id === user.id || c.meeting_by === user.id) return;
  const { rowCount } = await db.query('SELECT 1 FROM okc_events WHERE card_id = $1 AND user_id = $2 LIMIT 1', [c.id, user.id]);
  if (!rowCount) throw new HttpError(403, 'forbidden', 'Нет доступа к карточке');
}

export async function okcCardView(db: Db, user: CurrentUser, id: number, portalUrl: string, phoneKey: Buffer) {
  const c = await loadOkcCard(db, id);
  await assertCanSee(db, c, user);
  const [events, calls, tasks] = await Promise.all([
    db.query(`SELECT e.id, e.type, e.data, e.created_at AS "createdAt", u.name AS "userName"
                FROM okc_events e LEFT JOIN users u ON u.id = e.user_id
               WHERE e.card_id = $1 AND e.type <> 'offered' ORDER BY e.created_at DESC, e.id DESC`, [id]),
    db.query(`SELECT k.id, k.status, k.error, k.talk_seconds AS "talkSeconds", k.started_at AS "startedAt", cardinality(k.record_ids) AS records,
                     k.user_id AS "userId", u.name AS "userName"
                FROM okc_calls k LEFT JOIN users u ON u.id = k.user_id WHERE k.card_id = $1 ORDER BY k.started_at DESC`, [id]),
    db.query(`SELECT t.id, t.type, t.due_at AS "dueAt", t.done_at AS "doneAt", t.user_id AS "userId", u.name AS "userName"
                FROM okc_tasks t LEFT JOIN users u ON u.id = t.user_id WHERE t.card_id = $1 ORDER BY t.due_at`, [id]),
  ]);
  const full = can(user, 'phones.view');
  return {
    id: c.id,
    phone: full ? `+${decryptPhone(c.phone_enc, phoneKey)}` : maskPhone(c.phone_last2),
    clientName: c.client_name,
    status: c.status,
    statusLabel: OKC_STATUS_LABELS[c.status],
    ownerId: c.owner_id,
    ownerName: c.owner_name,
    pinUntil: c.pin_until,
    availableAt: c.available_at,
    callbackAt: c.callback_at,
    isCurrent: c.current_user_id === user.id,
    canAct: c.current_user_id === user.id || c.owner_id === user.id || c.meeting_by === user.id,
    attempts: c.attempts,
    refuseReason: c.refuse_reason,
    meeting: c.meeting_at ? {
      at: c.meeting_at, type: c.meeting_type, typeLabel: c.meeting_type ? MEETING_TYPES[c.meeting_type] : null,
      region: c.meeting_region, regionLabel: c.meeting_region ? MEETING_REGIONS[c.meeting_region] : null, byName: c.meeting_by_name,
    } : null,
    dealId: c.bitrix_deal_id ? Number(c.bitrix_deal_id) : null,
    dealUrl: c.bitrix_deal_id && portalUrl && can(user, 'bitrix.deal_link') ? `${portalUrl}/crm/deal/details/${c.bitrix_deal_id}/` : null,
    bitrixError: c.bitrix_error,
    batchName: c.batch_name,
    createdAt: c.created_at,
    events: events.rows,
    calls: calls.rows.map((k) => ({ ...k, canListen: k.records > 0 && (can(user, 'recordings.all') || (can(user, 'recordings.own') && k.userId === user.id)) })),
    tasks: tasks.rows,
  };
}

// ——— Действия по карточке

export async function addComment(db: Db, user: CurrentUser, id: number, text: string) {
  const c = await loadOkcCard(db, id);
  assertCanAct(c, user);
  const t = text.trim();
  if (!t) throw new HttpError(400, 'empty', 'Напишите комментарий');
  await event(db, id, 'comment', user.id, { text: t.slice(0, 3000) });
}

const days = (n: number) => n * 86_400_000;

/** «Позвонить позднее»: карточка уходит в конец очереди, снова выдаётся через laterMinutes и закреплена за сотрудником. */
export async function callLater(db: Db, user: CurrentUser, id: number, s: OkcSettings) {
  const c = await loadOkcCard(db, id);
  assertCanAct(c, user);
  if (!WORKABLE.includes(c.status)) throw new HttpError(409, 'bad_status', 'По этой карточке звонок уже не нужен');
  const at = new Date(Date.now() + s.laterMinutes * 60_000);
  await db.query(
    `UPDATE okc_cards SET status = 'later', owner_id = $2, pin_kind = 'later', pin_until = $3, available_at = $4,
            current_user_id = NULL, current_since = NULL, updated_at = now() WHERE id = $1`,
    [id, user.id, new Date(Date.now() + days(s.pinDays)), at],
  );
  await event(db, id, 'later', user.id, { availableAt: at });
}

export function parseFuture(value: unknown, what: string, now = new Date()): Date {
  const d = typeof value === 'string' ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) throw new HttpError(400, 'bad_date', `Укажите дату и время ${what}`);
  if (d.getTime() < now.getTime() + 60_000) throw new HttpError(400, 'bad_date', `Время ${what} уже прошло — выберите время в будущем`);
  if (d.getTime() > now.getTime() + days(366)) throw new HttpError(400, 'bad_date', `Дата ${what} — не дальше чем через год`);
  return d;
}

/** «Есть договорённость»: звонок в оговорённое время, карточка закреплена за сотрудником. */
export async function setAgreement(db: Db, user: CurrentUser, id: number, at: Date, s: OkcSettings) {
  const c = await loadOkcCard(db, id);
  assertCanAct(c, user);
  if (!WORKABLE.includes(c.status)) throw new HttpError(409, 'bad_status', 'По этой карточке звонок уже не нужен');
  const pin = new Date(Math.max(Date.now() + days(s.pinDays), at.getTime() + days(1)));
  await db.query(
    `UPDATE okc_cards SET status = 'agreement', owner_id = $2, pin_kind = 'agreement', pin_until = $3, callback_at = $4, available_at = $4,
            current_user_id = NULL, current_since = NULL, updated_at = now() WHERE id = $1`,
    [id, user.id, pin, at],
  );
  await event(db, id, 'agreement', user.id, { at });
}

export async function refuse(db: Db, user: CurrentUser, id: number, reasonId: number) {
  const c = await loadOkcCard(db, id);
  assertCanAct(c, user);
  if (!WORKABLE.includes(c.status)) throw new HttpError(409, 'bad_status', 'Отказ можно поставить только карточке в обзвоне');
  if (!Number.isInteger(reasonId) || reasonId <= 0) throw new HttpError(400, 'bad_reason', 'Выберите причину отказа');
  const { rows } = await db.query<{ name: string }>('SELECT name FROM okc_refuse_reasons WHERE id = $1 AND active', [reasonId]);
  if (!rows[0]) throw new HttpError(400, 'bad_reason', 'Выберите причину отказа');
  await db.query(
    `UPDATE okc_cards SET status = 'refused', refuse_reason_id = $2, owner_id = NULL, pin_kind = NULL, pin_until = NULL,
            callback_at = NULL, current_user_id = NULL, current_since = NULL, updated_at = now() WHERE id = $1`,
    [id, reasonId],
  );
  await event(db, id, 'refused', user.id, { reason: rows[0].name });
}

export interface MeetingInput {
  at: Date;
  type: MeetingType;
  region: MeetingRegion;
  clientName: string;
  comment: string;
}

export function parseMeeting(body: Record<string, unknown>): MeetingInput {
  const type = String(body.type ?? '') as MeetingType;
  const region = String(body.region ?? '') as MeetingRegion;
  if (!(type in MEETING_TYPES)) throw new HttpError(400, 'bad_type', 'Выберите тип встречи: офисная или ДКС');
  if (!(region in MEETING_REGIONS)) throw new HttpError(400, 'bad_region', 'Выберите: город, область или не Пермский край');
  const clientName = String(body.clientName ?? '').trim();
  if (!clientName) throw new HttpError(400, 'bad_name', 'Введите имя клиента — оно уйдёт в Битрикс24');
  return { at: parseFuture(body.at, 'встречи'), type, region, clientName: clientName.slice(0, 200), comment: String(body.comment ?? '').trim().slice(0, 3000) };
}

/** «Согласен на встречу»: статус, дело-напоминание для офисной встречи. Сделку в Битрикс24 создаёт okc/bitrix.ts. */
export async function setMeeting(db: Db, user: CurrentUser, id: number, m: MeetingInput, s: OkcSettings, tz: string) {
  const c = await loadOkcCard(db, id);
  assertCanAct(c, user);
  if (!WORKABLE.includes(c.status)) throw new HttpError(409, 'bad_status', 'Встречу можно назначить только карточке в обзвоне');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE okc_cards SET status = 'meeting', client_name = $2, meeting_at = $3, meeting_type = $4, meeting_region = $5, meeting_by = $6,
              owner_id = $6, pin_kind = NULL, pin_until = NULL, callback_at = NULL, current_user_id = NULL, current_since = NULL,
              bitrix_deal_id = NULL, bitrix_event_id = NULL, bitrix_error = NULL, updated_at = now() WHERE id = $1`,
      [id, m.clientName, m.at, m.type, m.region, user.id],
    );
    if (m.comment) await event(client, id, 'comment', user.id, { text: m.comment });
    await event(client, id, 'meeting_set', user.id, { at: m.at, type: m.type, region: m.region, operatorId: user.id });
    const due = reminderDue(m.at, m.type, s.reminderHours, tz);
    if (due) await client.query("INSERT INTO okc_tasks (card_id, user_id, type, due_at) VALUES ($1, $2, 'meeting_reminder', $3)", [id, user.id, due]);
    await client.query('COMMIT');
    return { reminderAt: due };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ——— Возврат и открепление

/** «Вернуть в работу»: карточка снова в общей базе обзвона. */
export async function returnToWork(db: Db, user: CurrentUser, id: number) {
  const c = await loadOkcCard(db, id);
  if (c.status === 'meeting' || c.status === 'meeting_done') throw new HttpError(409, 'bad_status', 'По карточке назначена или прошла встреча');
  await db.query(
    `UPDATE okc_cards SET status = 'new', owner_id = NULL, pin_kind = NULL, pin_until = NULL, callback_at = NULL, refuse_reason_id = NULL,
            available_at = now(), current_user_id = NULL, current_since = NULL, updated_at = now() WHERE id = $1`,
    [id],
  );
  await event(db, id, 'returned', user.id, { from: c.status });
}

/** Снимает карточки с сотрудника в общую базу: одну (cardId) или все его карточки в обзвоне. */
export async function releaseCards(db: Db, by: number | null, opts: { cardId?: number; ownerId?: number }, reason: 'manual' | 'auto' = 'manual') {
  const where = opts.cardId ? 'id = $1' : '(owner_id = $1 OR current_user_id = $1)';
  const { rows } = await db.query<{ id: number; owner_id: number | null }>(
    `UPDATE okc_cards SET status = CASE WHEN status IN ('later', 'agreement') THEN 'new' ELSE status END,
            owner_id = NULL, pin_kind = NULL, pin_until = NULL, callback_at = NULL, available_at = LEAST(available_at, now()),
            current_user_id = NULL, current_since = NULL, updated_at = now()
      WHERE ${where} AND status IN ('new', 'later', 'agreement', 'meeting_failed')
      RETURNING id, owner_id`,
    [opts.cardId ?? opts.ownerId],
  );
  for (const r of rows) await event(db, r.id, 'released', by, { reason });
  return rows.length;
}

/**
 * Автооткрепление: закрепление истекло или сотрудник не заходил дольше, чем положено для этого вида карточки.
 * Карточка уходит в общую базу, история и комментарии сохраняются — их увидит следующий оператор.
 */
export async function autoRelease(db: Db, s: OkcSettings, now = new Date()): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `UPDATE okc_cards c SET status = CASE WHEN c.status IN ('later', 'agreement') THEN 'new' ELSE c.status END,
            owner_id = NULL, pin_kind = NULL, pin_until = NULL, callback_at = NULL, available_at = LEAST(c.available_at, $1),
            current_user_id = NULL, current_since = NULL, updated_at = now()
       FROM users u
      WHERE u.id = c.owner_id AND c.status IN ('new', 'later', 'agreement', 'meeting_failed') AND c.current_user_id IS NULL
        AND (c.pin_until < $1::timestamptz OR NOT u.active
             OR COALESCE(u.last_seen_at, c.updated_at) < $1::timestamptz - make_interval(days => CASE c.pin_kind
                  WHEN 'later' THEN $2::int WHEN 'agreement' THEN $3::int WHEN 'meeting_failed' THEN $4::int ELSE $2::int END))
      RETURNING c.id`,
    [now, s.releaseLaterDays, s.releaseAgreementDays, s.releaseFailedDays],
  );
  for (const r of rows) await event(db, r.id, 'released', null, { reason: 'auto' });
  // Карточка, оставленная на экране без действия больше 2 часов, возвращается в очередь
  await db.query(
    `UPDATE okc_cards SET current_user_id = NULL, current_since = NULL WHERE current_user_id IS NOT NULL AND current_since < $1::timestamptz - interval '2 hours'`,
    [now],
  );
  return rows.length;
}

// ——— Дела

export async function myTasks(db: Db, userId: number) {
  const { rows } = await db.query(
    `SELECT t.id, t.type, t.due_at AS "dueAt", t.card_id AS "cardId", c.client_name AS "clientName", c.phone_last2 AS "phoneTail",
            c.meeting_at AS "meetingAt", c.meeting_type AS "meetingType"
       FROM okc_tasks t JOIN okc_cards c ON c.id = t.card_id
      WHERE t.user_id = $1 AND t.done_at IS NULL ORDER BY t.due_at`,
    [userId],
  );
  return rows;
}

export async function updateTask(db: Db, user: CurrentUser, taskId: number, action: { dueAt?: Date; done?: boolean }) {
  const { rows } = await db.query<{ card_id: number; user_id: number }>('SELECT card_id, user_id FROM okc_tasks WHERE id = $1', [taskId]);
  if (!rows[0] || (rows[0].user_id !== user.id && !can(user, 'okc.reassign'))) throw new HttpError(404, 'not_found', 'Дело не найдено');
  if (action.done) {
    await db.query('UPDATE okc_tasks SET done_at = now() WHERE id = $1', [taskId]);
    await event(db, rows[0].card_id, 'task_done', user.id, { taskId });
  } else if (action.dueAt) {
    await db.query('UPDATE okc_tasks SET due_at = $2 WHERE id = $1', [taskId, action.dueAt]);
    await event(db, rows[0].card_id, 'task_moved', user.id, { taskId, dueAt: action.dueAt });
  }
}
