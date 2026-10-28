import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../app.js';
import { HttpError, can } from '../auth/guard.js';
import { audit } from '../db/users.js';
import { getSetting, setSetting } from '../db/settings.js';
import { maskPhone, decryptPhone } from '../auth/phone.js';
import { parsePeriod } from './reports.js';
import {
  addComment, callLater, loadOkcCard, myTasks, nextCard, okcCardView, okcEvent, operatorState, parseFuture, parseMeeting,
  refuse, releaseCards, returnToWork, setAgreement, setMeeting, setOperatorStatus, updateTask, OKC_STATUS_LABELS,
  type OkcCardStatus, type OperatorStatus,
} from '../okc/service.js';
import { markMeetingDone, markMeetingFailed, pushMeeting } from '../okc/bitrix.js';
import { importBase } from '../okc/base.js';
import { bonusHistory, bonusSummary, decideWithdrawal, requestWithdrawal } from '../okc/bonus.js';
import { okcStats } from '../okc/stats.js';

const idOf = (req: FastifyRequest) => {
  const id = Number((req.params as { id: string }).id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad_id', 'Неверный номер');
  return id;
};

/** Разделы «Мои карточки» */
const SECTIONS: Record<string, OkcCardStatus[]> = {
  meeting: ['meeting'],
  agreement: ['agreement'],
  later: ['later', 'meeting_failed'],
  done: ['meeting_done'],
};

export async function okcRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, need, config, bx } = ctx;
  const settings = () => getSetting(db, 'okc');

  // ——— Оператор

  app.get('/api/okc/me', async (req) => {
    const user = await need(req, 'okc.work');
    const [state, cur, counts, tasksDue, bonus] = await Promise.all([
      operatorState(db, user.id),
      db.query<{ id: number }>('SELECT id FROM okc_cards WHERE current_user_id = $1', [user.id]),
      db.query<{ status: string; n: string }>('SELECT status, count(*) AS n FROM okc_cards WHERE owner_id = $1 GROUP BY status', [user.id]),
      db.query<{ n: string }>('SELECT count(*) AS n FROM okc_tasks WHERE user_id = $1 AND done_at IS NULL AND due_at <= now() + interval \'15 minutes\'', [user.id]),
      bonusSummary(db, user.id),
    ]);
    const c = Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.n)]));
    return {
      ...state,
      currentCardId: cur.rows[0]?.id ?? null,
      counts: { meeting: c.meeting ?? 0, agreement: c.agreement ?? 0, later: (c.later ?? 0) + (c.meeting_failed ?? 0), done: c.meeting_done ?? 0, tasksDue: Number(tasksDue.rows[0].n) },
      bonusAvailable: bonus.available,
    };
  });

  app.post('/api/okc/status', async (req) => {
    const user = await need(req, 'okc.work');
    const status = (req.body as { status?: string })?.status as OperatorStatus;
    if (!['ready', 'break', 'offline'].includes(status)) throw new HttpError(400, 'bad_status', 'Неизвестный статус');
    await setOperatorStatus(db, user.id, status);
    return operatorState(db, user.id);
  });

  app.post('/api/okc/next', async (req) => {
    const user = await need(req, 'okc.work');
    return { cardId: await nextCard(db, user.id) };
  });

  app.get('/api/okc/cards/:id', async (req) => {
    const user = await need(req, 'okc.work', 'okc.base');
    return okcCardView(db, user, idOf(req), bx.portalUrl, config.phoneKey);
  });

  app.post('/api/okc/cards/:id/comment', async (req) => {
    const user = await need(req, 'okc.work');
    await addComment(db, user, idOf(req), String((req.body as { text?: string })?.text ?? ''));
    return { ok: true };
  });

  app.post('/api/okc/cards/:id/later', async (req) => {
    const user = await need(req, 'okc.work');
    await callLater(db, user, idOf(req), await settings());
    return { ok: true };
  });

  app.post('/api/okc/cards/:id/agreement', async (req) => {
    const user = await need(req, 'okc.work');
    await setAgreement(db, user, idOf(req), parseFuture((req.body as { at?: string })?.at, 'звонка'), await settings());
    return { ok: true };
  });

  app.post('/api/okc/cards/:id/refuse', async (req) => {
    const user = await need(req, 'okc.work');
    await refuse(db, user, idOf(req), Number((req.body as { reasonId?: number })?.reasonId));
    return { ok: true };
  });

  app.post('/api/okc/cards/:id/meeting', async (req) => {
    const user = await need(req, 'okc.work');
    const id = idOf(req);
    const m = parseMeeting((req.body ?? {}) as Record<string, unknown>);
    const r = await setMeeting(db, user, id, m, await settings(), config.tz);
    const deal = await pushMeeting(db, bx, config.phoneKey, config.tz, id, ctx.log);
    return { ...r, deal };
  });

  // Звонок через UIS: номер подставляет сервер
  app.post('/api/okc/cards/:id/call', async (req) => {
    const user = await need(req, 'okc.work');
    const id = idOf(req);
    if (!ctx.uis.configured) throw new HttpError(400, 'uis_off', 'Телефония UIS ещё не подключена');
    if (!user.uisEmployeeId) throw new HttpError(400, 'uis_employee', 'В вашем профиле не указан ID сотрудника UIS — обратитесь к администратору');
    const { virtualNumber } = await getSetting(db, 'uis');
    if (!virtualNumber) throw new HttpError(400, 'uis_number', 'В настройках не указан виртуальный номер UIS');
    const c = await loadOkcCard(db, id);
    if (c.current_user_id !== user.id && c.owner_id !== user.id && c.meeting_by !== user.id) throw new HttpError(403, 'not_yours', 'Эта карточка сейчас не у вас');
    const { rows } = await db.query<{ id: number }>('INSERT INTO okc_calls (card_id, user_id) VALUES ($1, $2) RETURNING id', [id, user.id]);
    const callId = rows[0].id;
    await db.query('UPDATE okc_cards SET attempts = attempts + 1, last_call_at = now() WHERE id = $1', [id]);
    try {
      const session = await ctx.uis.startEmployeeCall({ employeeId: user.uisEmployeeId, contact: decryptPhone(c.phone_enc, config.phoneKey), virtualNumber, externalId: `okc-${callId}` });
      await db.query("UPDATE okc_calls SET uis_session_id = $2, status = 'ringing' WHERE id = $1", [callId, session]);
      await okcEvent(db, id, 'call', user.id, { callId });
      return { callId, status: 'ringing' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.query("UPDATE okc_calls SET status = 'error', error = $2, ended_at = now() WHERE id = $1", [callId, message]);
      throw new HttpError(502, 'uis_error', message);
    }
  });

  app.get('/api/okc/calls/:id', async (req) => {
    const user = await need(req, 'okc.work');
    const { rows } = await db.query('SELECT id, status, talk_seconds AS "talkSeconds", error, user_id FROM okc_calls WHERE id = $1', [idOf(req)]);
    if (!rows[0] || rows[0].user_id !== user.id) throw new HttpError(404, 'not_found', 'Звонок не найден');
    return rows[0];
  });

  app.post('/api/okc/calls/:id/hangup', async (req) => {
    const user = await need(req, 'okc.work');
    const { rows } = await db.query<{ uis_session_id: string | null; user_id: number }>('SELECT uis_session_id, user_id FROM okc_calls WHERE id = $1', [idOf(req)]);
    if (!rows[0] || rows[0].user_id !== user.id) throw new HttpError(404, 'not_found', 'Звонок не найден');
    if (rows[0].uis_session_id) await ctx.uis.releaseCall(Number(rows[0].uis_session_id)).catch(() => undefined);
    await db.query("UPDATE okc_calls SET status = 'ended', ended_at = COALESCE(ended_at, now()) WHERE id = $1", [idOf(req)]);
    return { ok: true };
  });

  // Мои карточки: встречи, договорённости, позвонить позднее, состоявшиеся
  app.get('/api/okc/my', async (req) => {
    const user = await need(req, 'okc.work');
    const section = (req.query as { section?: string }).section ?? 'meeting';
    const statuses = SECTIONS[section];
    if (!statuses) throw new HttpError(400, 'bad_section', 'Неизвестный раздел');
    const { rows } = await db.query(
      `SELECT c.id, c.client_name AS "clientName", c.phone_last2 AS "phoneTail", c.status, c.callback_at AS "callbackAt",
              c.available_at AS "availableAt", c.pin_until AS "pinUntil", c.meeting_at AS "meetingAt", c.meeting_type AS "meetingType",
              c.meeting_region AS "meetingRegion", c.updated_at AS "updatedAt",
              (SELECT min(t.due_at) FROM okc_tasks t WHERE t.card_id = c.id AND t.done_at IS NULL) AS "taskDueAt"
         FROM okc_cards c WHERE c.owner_id = $1 AND c.status = ANY($2)
        ORDER BY COALESCE(c.meeting_at, c.callback_at, c.available_at) ${section === 'done' ? 'DESC' : 'ASC'} LIMIT 500`,
      [user.id, statuses],
    );
    return { items: rows.map((r) => ({ ...r, statusLabel: OKC_STATUS_LABELS[r.status as OkcCardStatus] })) };
  });

  app.get('/api/okc/tasks', async (req) => {
    const user = await need(req, 'okc.work');
    return { items: await myTasks(db, user.id) };
  });

  app.put('/api/okc/tasks/:id', async (req) => {
    const user = await need(req, 'okc.work');
    const b = (req.body ?? {}) as { dueAt?: string; done?: boolean };
    await updateTask(db, user, idOf(req), b.done ? { done: true } : { dueAt: parseFuture(b.dueAt, 'дела') });
    return { ok: true };
  });

  app.get('/api/okc/reasons', async (req) => {
    await need(req, 'okc.work', 'okc.base', 'integrations.manage');
    const { rows } = await db.query('SELECT id, name, active, sort FROM okc_refuse_reasons ORDER BY sort, id');
    return { items: rows };
  });

  app.get('/api/okc/bonus', async (req) => {
    const user = await need(req, 'okc.work');
    const s = await settings();
    return { summary: await bonusSummary(db, user.id), ...(await bonusHistory(db, user.id)), prices: { office: s.bonusOffice, dks: s.bonusDks } };
  });

  app.post('/api/okc/bonus/withdraw', async (req) => {
    const user = await need(req, 'okc.work');
    const r = await requestWithdrawal(db, user.id, Number((req.body as { amount?: number })?.amount));
    await audit(db, user.id, 'bonus_withdraw_request', `withdrawal:${r.id}`, { amount: Number((req.body as { amount?: number })?.amount) }, req.ip);
    return r;
  });

  app.get('/api/okc/stats', async (req) => {
    const user = await need(req, 'okc.work', 'okc.stats.all');
    const q = req.query as { from?: string; to?: string; userId?: string };
    const p = parsePeriod(q);
    const all = can(user, 'okc.stats.all');
    const stats = await okcStats(db, p.from, p.to, all ? (q.userId ? Number(q.userId) : undefined) : user.id);
    return all ? stats : { ...stats, base: {} };
  });

  // ——— Супервайзер и администратор

  app.post('/api/okc/base', async (req) => {
    const user = await need(req, 'okc.base');
    const b = (req.body ?? {}) as { name?: string; text?: string };
    if (!b.text?.trim()) throw new HttpError(400, 'empty', 'Вставьте номера или выберите файл');
    if (b.text.length > 20_000_000) throw new HttpError(400, 'too_big', 'Файл слишком большой: загрузите частями до 500 000 номеров');
    const r = await importBase(db, user.id, b.name?.trim() || `База от ${new Date().toLocaleDateString('ru-RU')}`, b.text, config.phoneKey);
    await audit(db, user.id, 'okc_base_upload', `batch:${r.batchId}`, r, req.ip);
    return r;
  });

  app.get('/api/okc/batches', async (req) => {
    await need(req, 'okc.base');
    const { rows } = await db.query(
      `SELECT b.id, b.name, b.total, b.added, b.duplicates, b.invalid, b.created_at AS "createdAt", u.name AS "uploadedBy",
              (SELECT count(*) FROM okc_cards c WHERE c.batch_id = b.id AND c.status = 'new' AND c.owner_id IS NULL)::int AS "left"
         FROM okc_batches b LEFT JOIN users u ON u.id = b.uploaded_by ORDER BY b.id DESC LIMIT 100`,
    );
    return { items: rows };
  });

  app.get('/api/okc/cards', async (req) => {
    const user = await need(req, 'okc.base');
    const q = req.query as { status?: string; ownerId?: string; tail?: string; page?: string };
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status && q.status in OKC_STATUS_LABELS) where.push(`c.status = $${params.push(q.status)}`);
    if (q.ownerId === 'none') where.push('c.owner_id IS NULL');
    else if (q.ownerId) where.push(`c.owner_id = $${params.push(Number(q.ownerId))}`);
    if (q.tail && /^\d{2}$/.test(q.tail)) where.push(`c.phone_last2 = $${params.push(q.tail)}`);
    const page = Math.max(1, Number(q.page) || 1);
    const { rows } = await db.query(
      `SELECT c.id, c.phone_enc, c.phone_last2, c.client_name AS "clientName", c.status, o.name AS "ownerName", c.attempts,
              c.meeting_at AS "meetingAt", c.updated_at AS "updatedAt", r.name AS "refuseReason", count(*) OVER () AS total
         FROM okc_cards c LEFT JOIN users o ON o.id = c.owner_id LEFT JOIN okc_refuse_reasons r ON r.id = c.refuse_reason_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.updated_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`,
      params,
    );
    const full = can(user, 'phones.view');
    return {
      total: Number(rows[0]?.total ?? 0),
      items: rows.map(({ phone_enc, phone_last2, total, ...r }) => ({
        ...r, statusLabel: OKC_STATUS_LABELS[r.status as OkcCardStatus], phone: full ? `+${decryptPhone(phone_enc, config.phoneKey)}` : maskPhone(phone_last2),
      })),
    };
  });

  app.post('/api/okc/cards/:id/return', async (req) => {
    const user = await need(req, 'okc.return');
    await returnToWork(db, user, idOf(req));
    return { ok: true };
  });

  app.post('/api/okc/cards/:id/release', async (req) => {
    const user = await need(req, 'okc.reassign');
    return { released: await releaseCards(db, user.id, { cardId: idOf(req) }) };
  });

  app.post('/api/okc/operators/:id/release', async (req) => {
    const user = await need(req, 'okc.reassign');
    const n = await releaseCards(db, user.id, { ownerId: idOf(req) });
    await audit(db, user.id, 'okc_release_all', `user:${idOf(req)}`, { released: n }, req.ip);
    return { released: n };
  });

  app.post('/api/okc/cards/:id/push-deal', async (req) => {
    await need(req, 'okc.base');
    return pushMeeting(db, bx, config.phoneKey, config.tz, idOf(req), ctx.log);
  });

  // Итог встречи вручную — если стадии сделок ОКЦ в Битрикс24 не настроены
  app.post('/api/okc/cards/:id/meeting-result', async (req) => {
    const user = await need(req, 'okc.base');
    const result = (req.body as { result?: string })?.result;
    const s = await settings();
    const ok = result === 'done' ? await markMeetingDone(db, idOf(req), s) : result === 'failed' ? await markMeetingFailed(db, idOf(req), s) : null;
    if (ok === null) throw new HttpError(400, 'bad_result', 'Итог: состоялась или не состоялась');
    if (!ok) throw new HttpError(409, 'bad_status', 'По карточке нет назначенной встречи');
    await audit(db, user.id, 'okc_meeting_result', `okc:${idOf(req)}`, { result }, req.ip);
    return { ok: true };
  });

  app.get('/api/okc/operators', async (req) => {
    await need(req, 'okc.stats.all', 'okc.reassign');
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.active, u.last_seen_at AS "lastSeenAt", COALESCE(s.status, 'offline') AS status, s.since,
              (SELECT c.id FROM okc_cards c WHERE c.current_user_id = u.id) AS "currentCardId",
              (SELECT count(*) FROM okc_cards c WHERE c.owner_id = u.id AND c.status IN ('later', 'agreement', 'meeting_failed'))::int AS pinned,
              (SELECT count(*) FROM okc_cards c WHERE c.owner_id = u.id AND c.status = 'meeting')::int AS meetings
         FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN okc_operator_state s ON s.user_id = u.id
        WHERE ('okc.work' = ANY(r.permissions) OR 'okc.work' = ANY(u.grant_perms)) AND NOT ('okc.work' = ANY(u.revoke_perms))
        ORDER BY u.active DESC, u.name`,
    );
    return { items: rows };
  });

  app.get('/api/okc/withdrawals', async (req) => {
    await need(req, 'okc.payouts');
    const status = (req.query as { status?: string }).status;
    const { rows } = await db.query(
      `SELECT w.id, w.amount::float AS amount, w.status, w.comment, w.created_at AS "createdAt", w.decided_at AS "decidedAt",
              u.id AS "userId", u.name AS "userName", d.name AS "decidedBy"
         FROM okc_withdrawals w JOIN users u ON u.id = w.user_id LEFT JOIN users d ON d.id = w.decided_by
        ${status ? 'WHERE w.status = $1' : ''} ORDER BY (w.status = 'pending') DESC, w.created_at DESC LIMIT 200`,
      status ? [status] : [],
    );
    const balances = await Promise.all([...new Set(rows.map((r) => r.userId as number))].map(async (id) => [id, await bonusSummary(db, id)] as const));
    return { items: rows, balances: Object.fromEntries(balances) };
  });

  app.post('/api/okc/withdrawals/:id', async (req) => {
    const user = await need(req, 'okc.payouts');
    const b = (req.body ?? {}) as { approve?: boolean; comment?: string };
    await decideWithdrawal(db, user.id, idOf(req), Boolean(b.approve), String(b.comment ?? ''));
    await audit(db, user.id, b.approve ? 'bonus_withdraw_approve' : 'bonus_withdraw_reject', `withdrawal:${idOf(req)}`, { comment: b.comment ?? '' }, req.ip);
    return { ok: true };
  });

  app.get('/api/okc/prices', async (req) => {
    await need(req, 'okc.payouts');
    const s = await settings();
    return { office: s.bonusOffice, dks: s.bonusDks };
  });

  app.put('/api/okc/prices', async (req) => {
    const user = await need(req, 'okc.payouts');
    const b = (req.body ?? {}) as { office?: number; dks?: number };
    const office = Number(b.office);
    const dks = Number(b.dks);
    if (![office, dks].every((n) => Number.isFinite(n) && n >= 0 && n <= 1_000_000)) throw new HttpError(400, 'bad_price', 'Стоимость — число от 0 до 1 000 000');
    await setSetting(db, 'okc', { ...(await settings()), bonusOffice: office, bonusDks: dks });
    await audit(db, user.id, 'okc_prices', null, { office, dks }, req.ip);
    return { ok: true };
  });

  // Причины отказа
  app.put('/api/okc/reasons', async (req) => {
    const user = await need(req, 'integrations.manage', 'okc.payouts');
    const items = ((req.body as { items?: { id?: number; name: string; active: boolean }[] })?.items ?? []).filter((r) => r.name?.trim());
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      for (const [i, r] of items.entries()) {
        if (r.id) await client.query('UPDATE okc_refuse_reasons SET name = $2, active = $3, sort = $4 WHERE id = $1', [r.id, r.name.trim(), r.active !== false, i]);
        else await client.query('INSERT INTO okc_refuse_reasons (name, active, sort) VALUES ($1, $2, $3)', [r.name.trim(), r.active !== false, i]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await audit(db, user.id, 'okc_reasons', null, { count: items.length }, req.ip);
    return { ok: true };
  });

  app.get('/api/bitrix/calendar-sections', async (req) => {
    await need(req, 'integrations.manage');
    const q = req.query as { type?: string; ownerId?: string };
    const items = await bx.result<{ ID: string; NAME: string }[]>('calendar.section.get', { type: q.type || 'company_calendar', ownerId: Number(q.ownerId) || 0 });
    return { items: items.map((s) => ({ id: Number(s.ID), name: s.NAME })) };
  });
}
