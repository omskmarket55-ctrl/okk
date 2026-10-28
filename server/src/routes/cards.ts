import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../app.js';
import { HttpError, can } from '../auth/guard.js';
import { audit } from '../db/users.js';
import { getSetting } from '../db/settings.js';
import { formatPhone, maskPhone } from '../auth/phone.js';
import {
  cardEvent, cardPhone, cardView, loadCard, openCard, parseCallbackAt, queueFor, saveResponse, scheduleCallback, STATUS_LABELS,
  type CardStatus,
} from '../cards/service.js';
import { sendReferral } from '../bitrix/leads.js';
import { SMS_PROVIDERS, fillSmsTemplate } from '../sms/providers.js';
import { decryptPhone } from '../auth/phone.js';

const idOf = (req: FastifyRequest) => {
  const id = Number((req.params as { id: string }).id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad_id', 'Неверный номер карточки');
  return id;
};

export async function cardRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, need, config, bx } = ctx;

  app.get('/api/queue', async (req) => {
    const user = await need(req, 'queue.work');
    return { items: await queueFor(db, user) };
  });

  app.get('/api/cards/:id', async (req) => {
    const user = await need(req, 'queue.work', 'responses.own', 'responses.all');
    const view = await cardView(db, user, idOf(req), config.phoneKey, bx.portalUrl);
    if (view.phoneFull) await audit(db, user.id, 'phone_view', `card:${view.id}`, {}, req.ip);
    return view;
  });

  app.post('/api/cards/:id/open', async (req) => {
    const user = await need(req, 'queue.work');
    await openCard(db, user, idOf(req));
    return { ok: true };
  });

  app.post('/api/cards/:id/callback', async (req) => {
    const user = await need(req, 'queue.work', 'queue.manage');
    const { at, note } = (req.body ?? {}) as { at?: string; note?: string };
    const card = await loadCard(db, idOf(req));
    const manual = card.status !== 'queued' || card.locked_by !== user.id;
    if (manual && !can(user, 'queue.manage')) throw new HttpError(403, 'forbidden', 'Переносить чужие перезвоны может только старший');
    await scheduleCallback(db, user, card.id, parseCallbackAt(at), note ?? '', manual ? 'manual' : 'later');
    return { ok: true };
  });

  app.post('/api/cards/:id/response', async (req) => {
    const user = await need(req, 'queue.work');
    const body = (req.body ?? {}) as { answers?: Record<string, never>; callbackAt?: string; versionId?: number };
    const id = idOf(req);
    const result = await saveResponse(db, user, id, { answers: body.answers ?? {}, callbackAt: body.callbackAt, versionId: Number(body.versionId) }, config.phoneKey);
    const leads = [];
    for (const rid of result.referralIds) {
      const r = await sendReferral(db, bx, config.phoneKey, rid);
      await cardEvent(db, id, r.ok ? 'lead_created' : 'lead_error', user.id, { referralId: rid, leadId: r.leadId, error: r.error });
      leads.push({ referralId: rid, ...r });
    }
    if (result.outcome !== 'callback') void completeActivity(ctx, id);
    return { ...result, leads };
  });

  // Повторная отправка рекомендации, если Битрикс24 был недоступен
  app.post('/api/referrals/:id/resend', async (req) => {
    const user = await need(req, 'leads.resend');
    const rid = idOf(req);
    const r = await sendReferral(db, bx, config.phoneKey, rid);
    const { rows } = await db.query<{ card_id: number }>('SELECT card_id FROM referrals WHERE id = $1', [rid]);
    if (rows[0]) await cardEvent(db, rows[0].card_id, r.ok ? 'lead_created' : 'lead_error', user.id, { referralId: rid, leadId: r.leadId, error: r.error, resend: true });
    return r;
  });

  // Полный номер — отдельным запросом и только с правом: каждый просмотр пишется в журнал
  app.get('/api/cards/:id/phone', async (req) => {
    const user = await need(req, 'phones.view');
    const { phone, card } = await cardPhone(db, idOf(req), config.phoneKey);
    await audit(db, user.id, 'phone_view', `card:${card.id}`, {}, req.ip);
    return { phone: formatPhone(phone) };
  });

  // Звонок через UIS: номер клиента подставляет сервер
  app.post('/api/cards/:id/call', async (req) => {
    const user = await need(req, 'queue.work');
    const id = idOf(req);
    if (!ctx.uis.configured) throw new HttpError(400, 'uis_off', 'Телефония UIS ещё не подключена');
    if (!user.uisEmployeeId) throw new HttpError(400, 'uis_employee', 'В вашем профиле не указан ID сотрудника UIS — обратитесь к администратору');
    const { virtualNumber } = await getSetting(db, 'uis');
    if (!virtualNumber) throw new HttpError(400, 'uis_number', 'В настройках не указан виртуальный номер UIS для обзвона');
    const { phone, card } = await cardPhone(db, id, config.phoneKey);
    if (card.locked_by !== user.id) throw new HttpError(409, 'taken', 'Сначала откройте карточку из очереди');
    const { rows } = await db.query<{ id: number }>('INSERT INTO calls (card_id, user_id, repeat) VALUES ($1, $2, $3) RETURNING id', [id, user.id, card.repeat]);
    const callId = rows[0].id;
    await db.query('UPDATE cards SET attempts = attempts + 1 WHERE id = $1', [id]);
    try {
      const session = await ctx.uis.startEmployeeCall({ employeeId: user.uisEmployeeId, contact: phone, virtualNumber, externalId: `okk-${callId}` });
      await db.query("UPDATE calls SET uis_session_id = $2, status = 'ringing' WHERE id = $1", [callId, session]);
      await cardEvent(db, id, 'call_started', user.id, { callId, repeat: card.repeat });
      return { callId, status: 'ringing' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.query("UPDATE calls SET status = 'error', error = $2, ended_at = now() WHERE id = $1", [callId, message]);
      await cardEvent(db, id, 'call_error', user.id, { callId, error: message });
      throw new HttpError(502, 'uis_error', message);
    }
  });

  app.post('/api/calls/:id/hangup', async (req) => {
    const user = await need(req, 'queue.work');
    const { rows } = await db.query<{ uis_session_id: string | null; user_id: number }>('SELECT uis_session_id, user_id FROM calls WHERE id = $1', [idOf(req)]);
    const call = rows[0];
    if (!call || call.user_id !== user.id) throw new HttpError(404, 'not_found', 'Звонок не найден');
    if (call.uis_session_id) await ctx.uis.releaseCall(Number(call.uis_session_id)).catch(() => undefined);
    await db.query("UPDATE calls SET status = 'ended', ended_at = COALESCE(ended_at, now()) WHERE id = $1", [idOf(req)]);
    return { ok: true };
  });

  app.get('/api/calls/:id', async (req) => {
    const user = await need(req, 'queue.work', 'responses.all');
    const { rows } = await db.query('SELECT id, status, talk_seconds AS "talkSeconds", error, user_id FROM calls WHERE id = $1', [idOf(req)]);
    if (!rows[0] || (rows[0].user_id !== user.id && !can(user, 'responses.all'))) throw new HttpError(404, 'not_found', 'Звонок не найден');
    return rows[0];
  });

  app.post('/api/cards/:id/sms', async (req) => {
    const user = await need(req, 'sms.send');
    const id = idOf(req);
    const body = (req.body ?? {}) as { provider?: string; templateId?: string; text?: string };
    const settings = await getSetting(db, 'sms');
    const providerId = (body.provider || settings.defaultProvider) as keyof typeof SMS_PROVIDERS | null;
    const providerCfg = providerId ? settings.providers[providerId] : undefined;
    if (!providerId || !providerCfg?.enabled) throw new HttpError(400, 'sms_off', 'Сервис СМС не выбран или выключен в настройках');
    const template = settings.templates.find((t) => t.id === body.templateId);
    const { phone, card } = await cardPhone(db, id, config.phoneKey);
    const base = template ? fillSmsTemplate(template.text, { fullName: card.client_name }) : '';
    const text = (settings.allowEdit && body.text?.trim() ? body.text.trim() : base).slice(0, 670);
    if (!text) throw new HttpError(400, 'sms_empty', 'Выберите шаблон или введите текст СМС');
    const result = await SMS_PROVIDERS[providerId].send({ to: phone, text, sender: providerCfg.sender, credentials: providerCfg.credentials });
    await db.query(
      'INSERT INTO sms_messages (card_id, user_id, provider, text, status, provider_message_id, error) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, user.id, providerId, text, result.ok ? 'sent' : 'error', result.messageId ?? null, result.error ?? null],
    );
    await cardEvent(db, id, result.ok ? 'sms_sent' : 'sms_error', user.id, { provider: providerId, error: result.error });
    if (!result.ok) throw new HttpError(502, 'sms_error', result.error ?? 'СМС не отправлено');
    return { ok: true };
  });

  app.get('/api/sms/templates', async (req) => {
    await need(req, 'sms.send');
    const s = await getSetting(db, 'sms');
    return { templates: s.templates, allowEdit: s.allowEdit, defaultProvider: s.defaultProvider };
  });

  // Список клиентов для админки и старших
  app.get('/api/cards', async (req) => {
    const user = await need(req, 'responses.all', 'responses.own');
    const q = req.query as { status?: string; search?: string; page?: string; userId?: string };
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status && q.status in STATUS_LABELS) where.push(`c.status = $${params.push(q.status)}`);
    if (q.search?.trim()) where.push(`(c.client_name ILIKE $${params.push(`%${q.search.trim()}%`)} OR c.deal_id::text = $${params.push(q.search.trim())})`);
    if (!can(user, 'responses.all')) where.push(`EXISTS (SELECT 1 FROM card_events e WHERE e.card_id = c.id AND e.user_id = $${params.push(user.id)})`);
    else if (q.userId) where.push(`EXISTS (SELECT 1 FROM responses r WHERE r.card_id = c.id AND r.user_id = $${params.push(Number(q.userId))})`);
    const page = Math.max(1, Number(q.page) || 1);
    const sql = `SELECT c.id, c.deal_id AS "dealId", c.client_name AS "clientName", c.phone_enc, c.phone_last2, c.status, c.repeat, c.callback_at AS "callbackAt",
                        c.created_at AS "createdAt", c.updated_at AS "updatedAt", c.attempts,
                        (SELECT r.nps FROM responses r WHERE r.card_id = c.id ORDER BY r.id DESC LIMIT 1) AS nps,
                        count(*) OVER () AS total
                   FROM cards c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                  ORDER BY c.updated_at DESC LIMIT 50 OFFSET ${(page - 1) * 50}`;
    const { rows } = await db.query(sql, params);
    const showPhone = can(user, 'phones.view');
    return {
      total: Number(rows[0]?.total ?? 0),
      page,
      items: rows.map(({ phone_enc, phone_last2, total, ...r }) => ({
        ...r,
        dealId: Number(r.dealId),
        statusLabel: r.status === 'queued' && r.repeat ? 'Повторный звонок' : STATUS_LABELS[r.status as CardStatus],
        phone: showPhone && phone_enc ? formatPhone(decryptPhone(phone_enc, config.phoneKey)) : maskPhone(phone_last2),
      })),
    };
  });

  // Управление очередью: вернуть в очередь, снять с обзвона, назначить сотрудника
  app.post('/api/cards/:id/manage', async (req) => {
    const user = await need(req, 'queue.manage', 'queue.assign');
    const id = idOf(req);
    const { action, userId } = (req.body ?? {}) as { action?: string; userId?: number | null };
    if (action === 'assign') {
      if (!can(user, 'queue.assign')) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
      await db.query('UPDATE cards SET assigned_user_id = $2, updated_at = now() WHERE id = $1', [id, userId ?? null]);
      await cardEvent(db, id, 'assigned', user.id, { userId: userId ?? null });
    } else if (action === 'requeue' || action === 'close') {
      if (!can(user, 'queue.manage')) throw new HttpError(403, 'forbidden', 'Недостаточно прав');
      await db.query(
        `UPDATE cards SET status = $2, callback_at = NULL, locked_by = NULL, locked_until = NULL, updated_at = now() WHERE id = $1`,
        [id, action === 'requeue' ? 'queued' : 'closed'],
      );
      await cardEvent(db, id, action === 'requeue' ? 'requeued' : 'closed', user.id);
    } else {
      throw new HttpError(400, 'bad_action', 'Неизвестное действие');
    }
    return { ok: true };
  });
}

/** Закрывает дело-триггер в Битрикс24, если это включено в настройках источника. */
async function completeActivity(ctx: AppContext, cardId: number) {
  try {
    const source = await getSetting(ctx.db, 'source');
    if (!source.completeActivity || !ctx.bx.configured) return;
    const { rows } = await ctx.db.query<{ activity_id: string | null }>('SELECT activity_id FROM cards WHERE id = $1', [cardId]);
    if (!rows[0]?.activity_id) return;
    await ctx.bx.call('crm.activity.update', { id: rows[0].activity_id, fields: { COMPLETED: 'Y' } });
    await cardEvent(ctx.db, cardId, 'activity_completed', null);
  } catch (err) {
    ctx.log.warn({ err, cardId }, 'Не удалось закрыть дело в Битрикс24');
  }
}
