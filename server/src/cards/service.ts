import type { Db } from '../db/pool.js';
import { getSetting } from '../db/settings.js';
import type { CurrentUser } from '../db/users.js';
import { HttpError, can } from '../auth/guard.js';
import { decryptPhone, encryptPhone, formatPhone, last2, maskPhone, normalizePhone } from '../auth/phone.js';
import {
  chosenAction, npsOf, pruneAnswers, validateAnswers,
  type Answers, type ReferralAnswer, type SurveySchema,
} from '../surveys/schema.js';

export type CardStatus = 'queued' | 'callback' | 'done' | 'refused' | 'closed';

export const STATUS_LABELS: Record<CardStatus, string> = {
  queued: 'В очереди',
  callback: 'Перезвон',
  done: 'Анкета заполнена',
  refused: 'Отказ от опроса',
  closed: 'Снята с обзвона',
};

/** Карточку открыл сотрудник: другим она не показывается 20 минут или пока он её не сохранит. */
const LOCK_MINUTES = 20;

interface CardRow {
  id: number;
  deal_id: string;
  activity_id: string | null;
  contact_id: string | null;
  client_name: string;
  phone_enc: string | null;
  phone_last2: string | null;
  deal_title: string | null;
  deal_fields: { code: string; label: string; value: string }[];
  survey_id: number | null;
  status: CardStatus;
  callback_at: Date | null;
  repeat: boolean;
  attempts: number;
  assigned_user_id: number | null;
  assigned_name: string | null;
  locked_by: number | null;
  locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

const CARD_SELECT = `SELECT c.*, a.name AS assigned_name FROM cards c LEFT JOIN users a ON a.id = c.assigned_user_id`;

async function loadCard(db: Db, id: number): Promise<CardRow> {
  const { rows } = await db.query<CardRow>(`${CARD_SELECT} WHERE c.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Карточка не найдена');
  return rows[0];
}

/** Оператор с правом «свои анкеты» видит только карточки, с которыми работал или которые ему назначены. */
async function assertCanSee(db: Db, user: CurrentUser, card: CardRow) {
  if (can(user, 'responses.all')) return;
  if (card.assigned_user_id === user.id || card.locked_by === user.id) return;
  if (can(user, 'queue.work') && card.status === 'queued' && (!card.assigned_user_id || card.assigned_user_id === user.id)) return;
  const { rowCount } = await db.query('SELECT 1 FROM card_events WHERE card_id = $1 AND user_id = $2 LIMIT 1', [card.id, user.id]);
  if (!rowCount) throw new HttpError(403, 'forbidden', 'Это карточка другого сотрудника');
}

const event = (db: Db, cardId: number, type: string, userId: number | null, data: object = {}) =>
  db.query('INSERT INTO card_events (card_id, type, user_id, data) VALUES ($1, $2, $3, $4)', [cardId, type, userId, data]);

/** Перезвоны, время которых подходит: возвращает в очередь за leadMinutes до назначенного времени. */
export async function returnDueCallbacks(db: Db, now = new Date()): Promise<number> {
  const { callbackLeadMinutes } = await getSetting(db, 'queue');
  const { rows } = await db.query<{ id: number; callback_at: Date }>(
    `UPDATE cards SET status = 'queued', repeat = true, locked_by = NULL, locked_until = NULL, updated_at = now()
      WHERE status = 'callback' AND callback_at - make_interval(mins => $1) <= $2
      RETURNING id, callback_at`,
    [callbackLeadMinutes, now],
  );
  for (const r of rows) await event(db, r.id, 'callback_due', null, { callbackAt: r.callback_at });
  return rows.length;
}

export interface QueueItem {
  id: number;
  clientName: string;
  phoneTail: string | null;
  dealTitle: string | null;
  repeat: boolean;
  attempts: number;
  callbackAt: Date | null;
  createdAt: Date;
  lockedByMe: boolean;
}

/** Очередь сотрудника: сначала перезвоны по времени, потом новые по порядку поступления. */
export async function queueFor(db: Db, user: CurrentUser): Promise<QueueItem[]> {
  const { rows } = await db.query<CardRow>(
    `${CARD_SELECT}
      WHERE c.status = 'queued'
        AND (c.assigned_user_id IS NULL OR c.assigned_user_id = $1)
        AND (c.locked_by IS NULL OR c.locked_by = $1 OR c.locked_until < now())
      ORDER BY c.repeat DESC, c.callback_at ASC NULLS LAST, c.created_at ASC
      LIMIT 200`,
    [user.id],
  );
  return rows.map((c) => ({
    id: c.id,
    clientName: c.client_name,
    phoneTail: c.phone_last2,
    dealTitle: c.deal_title,
    repeat: c.repeat,
    attempts: c.attempts,
    callbackAt: c.callback_at,
    createdAt: c.created_at,
    lockedByMe: c.locked_by === user.id && !!c.locked_until && c.locked_until > new Date(),
  }));
}

export async function activeSurvey(db: Db, surveyId: number | null): Promise<{ versionId: number; surveyId: number; name: string; schema: SurveySchema } | null> {
  const { rows } = await db.query<{ version_id: number; survey_id: number; name: string; schema: SurveySchema }>(
    `SELECT v.id AS version_id, s.id AS survey_id, s.name, v.schema
       FROM surveys s JOIN survey_versions v ON v.id = s.active_version_id
      WHERE ${surveyId ? 's.id = $1' : 'NOT s.archived'} ORDER BY s.id LIMIT 1`,
    surveyId ? [surveyId] : [],
  );
  const r = rows[0];
  return r ? { versionId: r.version_id, surveyId: r.survey_id, name: r.name, schema: r.schema } : null;
}

/** Полная карточка клиента. Номер — только с правом phones.view, иначе две последние цифры. */
export async function cardView(db: Db, user: CurrentUser, id: number, phoneKey: Buffer, portalUrl: string) {
  const c = await loadCard(db, id);
  await assertCanSee(db, user, c);
  const survey = await activeSurvey(db, c.survey_id);
  const [events, responses, referrals, calls, sms] = await Promise.all([
    db.query(`SELECT e.id, e.type, e.data, e.created_at AS "createdAt", u.name AS "userName"
                FROM card_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.card_id = $1 ORDER BY e.created_at DESC, e.id DESC`, [id]),
    db.query(`SELECT r.id, r.answers, r.nps, r.outcome, r.created_at AS "createdAt", r.updated_at AS "updatedAt", u.name AS "userName",
                     v.schema, v.version, s.name AS "surveyName"
                FROM responses r JOIN survey_versions v ON v.id = r.survey_version_id JOIN surveys s ON s.id = v.survey_id
                LEFT JOIN users u ON u.id = r.user_id WHERE r.card_id = $1 ORDER BY r.created_at DESC`, [id]),
    db.query<{ id: number; name: string; phone_enc: string; phone_last2: string; comment: string; status: string; bitrix_lead_id: string | null; error: string | null; created_at: Date }>(
      'SELECT * FROM referrals WHERE card_id = $1 ORDER BY id', [id]),
    db.query(`SELECT k.id, k.status, k.repeat, k.error, k.talk_seconds AS "talkSeconds", k.started_at AS "startedAt", k.ended_at AS "endedAt",
                     cardinality(k.record_ids) AS "records", k.user_id AS "userId", u.name AS "userName"
                FROM calls k LEFT JOIN users u ON u.id = k.user_id WHERE k.card_id = $1 ORDER BY k.started_at DESC`, [id]),
    db.query(`SELECT m.id, m.provider, m.text, m.status, m.error, m.created_at AS "createdAt", u.name AS "userName"
                FROM sms_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.card_id = $1 ORDER BY m.created_at DESC`, [id]),
  ]);
  const showPhone = can(user, 'phones.view');
  const showRefPhone = can(user, 'referrals.phones.view');
  const draft = responses.rows.find((r) => r.outcome === 'callback');
  return {
    id: c.id,
    dealId: Number(c.deal_id),
    dealUrl: can(user, 'bitrix.deal_link') && portalUrl ? `${portalUrl}/crm/deal/details/${c.deal_id}/` : null,
    clientName: c.client_name,
    phone: c.phone_enc && showPhone ? formatPhone(decryptPhone(c.phone_enc, phoneKey)) : maskPhone(c.phone_last2),
    phoneFull: Boolean(c.phone_enc && showPhone),
    hasPhone: Boolean(c.phone_enc),
    dealTitle: c.deal_title,
    fields: c.deal_fields,
    status: c.status,
    statusLabel: c.status === 'queued' && c.repeat ? 'Повторный звонок' : STATUS_LABELS[c.status],
    repeat: c.repeat,
    attempts: c.attempts,
    callbackAt: c.callback_at,
    assignedUserId: c.assigned_user_id,
    assignedName: c.assigned_name,
    createdAt: c.created_at,
    survey: survey && { versionId: survey.versionId, surveyId: survey.surveyId, name: survey.name, schema: survey.schema },
    /** Ответы прошлой попытки: клиент просил перезвонить — продолжаем с того же места */
    draftAnswers: draft ? (draft.answers as Answers) : null,
    responses: responses.rows,
    referrals: referrals.rows.map((r) => ({
      id: r.id, name: r.name, comment: r.comment, status: r.status, error: r.error, createdAt: r.created_at,
      phone: showRefPhone ? formatPhone(decryptPhone(r.phone_enc, phoneKey)) : maskPhone(r.phone_last2),
      leadId: r.bitrix_lead_id ? Number(r.bitrix_lead_id) : null,
      leadUrl: r.bitrix_lead_id && portalUrl && can(user, 'bitrix.deal_link') ? `${portalUrl}/crm/lead/details/${r.bitrix_lead_id}/` : null,
    })),
    calls: calls.rows.map((k) => ({ ...k, canListen: k.records > 0 && (can(user, 'recordings.all') || (can(user, 'recordings.own') && k.userId === user.id)) })),
    sms: sms.rows,
    events: events.rows,
  };
}

/** Сотрудник открыл карточку из очереди: закрепляем её за ним, чтобы двое не звонили одному клиенту. */
export async function openCard(db: Db, user: CurrentUser, id: number) {
  const { rows } = await db.query<{ repeat: boolean }>(
    `UPDATE cards SET locked_by = $2, locked_until = now() + make_interval(mins => $3), updated_at = now()
      WHERE id = $1 AND status = 'queued' AND (assigned_user_id IS NULL OR assigned_user_id = $2)
        AND (locked_by IS NULL OR locked_by = $2 OR locked_until < now())
      RETURNING repeat`,
    [id, user.id, LOCK_MINUTES],
  );
  if (!rows[0]) throw new HttpError(409, 'taken', 'Карточку уже открыл другой сотрудник или её нет в очереди');
  await event(db, id, 'opened', user.id, { repeat: rows[0].repeat });
}

/** Дата перезвона: не в прошлом и не дальше чем через полгода. */
export function parseCallbackAt(value: unknown, now = new Date()): Date {
  const d = typeof value === 'string' ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) throw new HttpError(400, 'bad_callback', 'Укажите дату и время перезвона');
  if (d.getTime() < now.getTime() + 60_000) throw new HttpError(400, 'bad_callback', 'Время перезвона уже прошло — выберите время в будущем');
  if (d.getTime() > now.getTime() + 183 * 86_400_000) throw new HttpError(400, 'bad_callback', 'Перезвон можно назначить не дальше чем через полгода');
  return d;
}

/** «Перезвонить позже» без анкеты: клиент занят, не ответил, попросил позвонить в другое время. */
export async function scheduleCallback(db: Db, user: CurrentUser, id: number, at: Date, note: string, reason: 'later' | 'manual') {
  const c = await loadCard(db, id);
  if (reason === 'later') {
    if (c.status !== 'queued' || (c.locked_by && c.locked_by !== user.id && c.locked_until && c.locked_until > new Date())) {
      throw new HttpError(409, 'taken', 'Карточка не в работе у вас');
    }
  }
  await db.query(
    `UPDATE cards SET status = 'callback', callback_at = $2, locked_by = NULL, locked_until = NULL, updated_at = now() WHERE id = $1`,
    [id, at],
  );
  await event(db, id, 'callback_scheduled', user.id, { at, note: note.slice(0, 500), reason });
}

export interface SaveResult {
  outcome: 'done' | 'callback' | 'refused';
  responseId: number;
  referralIds: number[];
}

/**
 * Сохраняет анкету. Ответы остаются только в нашей базе; телефоны рекомендаций шифруются,
 * в самих ответах остаются имя и две последние цифры.
 */
export async function saveResponse(
  db: Db, user: CurrentUser, id: number, input: { answers: Answers; callbackAt?: string; versionId: number }, phoneKey: Buffer,
): Promise<SaveResult> {
  const c = await loadCard(db, id);
  if (c.status !== 'queued') throw new HttpError(409, 'not_in_queue', 'Карточка уже обработана');
  if (c.locked_by && c.locked_by !== user.id && c.locked_until && c.locked_until > new Date()) {
    throw new HttpError(409, 'taken', 'С этой карточкой сейчас работает другой сотрудник');
  }
  const survey = await activeSurvey(db, c.survey_id);
  if (!survey) throw new HttpError(400, 'no_survey', 'Для карточки не опубликована анкета');
  const { rows: vr } = await db.query<{ schema: SurveySchema }>('SELECT schema FROM survey_versions WHERE id = $1', [input.versionId]);
  const schema = vr[0]?.schema ?? survey.schema;
  const versionId = vr[0] ? input.versionId : survey.versionId;

  const answers = input.answers ?? {};
  const action = chosenAction(schema, answers);
  const errors = validateAnswers(schema, answers, { partial: action === 'callback' || action === 'refuse' });
  if (Object.keys(errors).length) throw Object.assign(new HttpError(400, 'invalid_answers', 'Проверьте ответы анкеты'), { errors });
  const callbackAt = action === 'callback' ? parseCallbackAt(input.callbackAt) : null;
  const outcome = action === 'callback' ? 'callback' : action === 'refuse' ? 'refused' : 'done';

  const stored = pruneAnswers(schema, answers);
  const referrals: { name: string; phone: string; comment: string }[] = [];
  for (const q of schema.questions) {
    if (q.type !== 'referral' || !Array.isArray(stored[q.id])) continue;
    const list = stored[q.id] as ReferralAnswer[];
    const kept: { name: string; phoneTail: string; comment: string }[] = [];
    for (const r of list) {
      const phone = normalizePhone(r.phone);
      if (!phone) throw Object.assign(new HttpError(400, 'invalid_answers', 'Проверьте ответы анкеты'), { errors: { [q.id]: `Телефон ${r.phone} не похож на российский номер` } });
      referrals.push({ name: r.name.trim(), phone, comment: (r.comment ?? '').trim() });
      kept.push({ name: r.name.trim(), phoneTail: last2(phone), comment: (r.comment ?? '').trim() });
    }
    stored[q.id] = kept as unknown as ReferralAnswer[];
  }
  if (referrals.length && !can(user, 'leads.create')) throw new HttpError(403, 'forbidden', 'Нет права создавать лиды по рекомендации');

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Анкета после перезвона дописывается в ту же запись, а не создаёт вторую
    const prev = await client.query<{ id: number }>("SELECT id FROM responses WHERE card_id = $1 AND outcome = 'callback' ORDER BY id DESC LIMIT 1", [id]);
    let responseId: number;
    if (prev.rows[0]) {
      responseId = prev.rows[0].id;
      await client.query(
        'UPDATE responses SET answers = $2, nps = $3, outcome = $4, survey_version_id = $5, user_id = $6, updated_at = now() WHERE id = $1',
        [responseId, stored, npsOf(schema, answers), outcome, versionId, user.id],
      );
    } else {
      const r = await client.query<{ id: number }>(
        'INSERT INTO responses (card_id, survey_version_id, user_id, answers, nps, outcome) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [id, versionId, user.id, stored, npsOf(schema, answers), outcome],
      );
      responseId = r.rows[0].id;
    }
    const referralIds: number[] = [];
    for (const r of referrals) {
      const ins = await client.query<{ id: number }>(
        'INSERT INTO referrals (response_id, card_id, name, phone_enc, phone_last2, comment) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [responseId, id, r.name, encryptPhone(r.phone, phoneKey), last2(r.phone), r.comment],
      );
      referralIds.push(ins.rows[0].id);
    }
    await client.query(
      `UPDATE cards SET status = $2, callback_at = $3, locked_by = NULL, locked_until = NULL,
              assigned_user_id = COALESCE(assigned_user_id, $4), updated_at = now() WHERE id = $1`,
      [id, outcome, callbackAt, user.id],
    );
    await client.query("INSERT INTO card_events (card_id, type, user_id, data) VALUES ($1, 'response_saved', $2, $3)", [
      id, user.id, { outcome, nps: npsOf(schema, answers), referrals: referralIds.length, responseId },
    ]);
    if (callbackAt) {
      await client.query("INSERT INTO card_events (card_id, type, user_id, data) VALUES ($1, 'callback_scheduled', $2, $3)", [
        id, user.id, { at: callbackAt, reason: 'survey' },
      ]);
    }
    await client.query('COMMIT');
    return { outcome, responseId, referralIds };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Номер клиента для звонка или СМС — только на сервере, в браузер не уходит. */
export async function cardPhone(db: Db, id: number, phoneKey: Buffer): Promise<{ phone: string; card: CardRow }> {
  const card = await loadCard(db, id);
  if (!card.phone_enc) throw new HttpError(400, 'no_phone', 'У клиента в Битрикс24 не указан телефон');
  return { phone: decryptPhone(card.phone_enc, phoneKey), card };
}

export { event as cardEvent, loadCard, assertCanSee };
