// Сквозной сценарий ОКЦ на настоящей PostgreSQL (TEST_DATABASE_URL), иначе пропускается.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { seedUsers } from '../src/db/users.js';
import { BitrixClient } from '../src/bitrix/client.js';
import { UisCallApi } from '../src/uis/callApi.js';
import { autoRelease } from '../src/okc/service.js';
import { syncMeetingStages } from '../src/okc/bitrix.js';
import { getSetting } from '../src/db/settings.js';
import type { Config } from '../src/config.js';

const url = process.env.TEST_DATABASE_URL;
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

const calls: { method: string; body: string }[] = [];
const dealStages = new Map<string, string>();
let nextDeal = 7000;
const fakeBitrix = (async (u: string, init: RequestInit) => {
  const method = u.replace('https://test.bitrix24.ru/rest/1/hook/', '').replace('.json', '');
  const body = decodeURIComponent(String(init.body));
  calls.push({ method, body });
  switch (method) {
    case 'crm.duplicate.findbycomm': return json({ result: [] });
    case 'crm.contact.add': return json({ result: 501 });
    case 'crm.deal.add': { const id = ++nextDeal; dealStages.set(String(id), 'C7:NEW'); return json({ result: id }); }
    case 'calendar.event.add': return json({ result: 9001 });
    case 'crm.deal.list': return json({ result: [...dealStages.entries()].map(([ID, STAGE_ID]) => ({ ID, STAGE_ID })) });
    default: return json({ error: 'ERROR_METHOD_NOT_FOUND', error_description: method });
  }
}) as typeof fetch;

describe.skipIf(!url)('ОКЦ: обзвон базы, встречи, бонусы', () => {
  let db: pg.Pool;
  let app: FastifyInstance;
  let ctx: AppContext;
  const cookies: Record<string, string> = {};
  const ids: Record<string, number> = {};

  const req = async (who: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => {
    const res = await app.inject({
      method, url: path,
      headers: { cookie: cookies[who] ?? '', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.statusCode, body: res.json() };
  };
  const login = async (who: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ login: who, password }) });
    expect(res.statusCode).toBe(200);
    cookies[who] = String(res.headers['set-cookie']).split(';')[0];
  };
  const next = async (who: string) => (await req(who, 'POST', '/api/okc/next', {})).body.cardId as number | null;
  const inDays = (d: number, hour: number) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(hour, 0, 0, 0); return x.toISOString(); };

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await seedUsers(db, { login: 'admin', password: 'admin-password-1' });
    const config: Config = {
      port: 0, publicUrl: 'https://okk.test', databaseUrl: url!, sessionSecret: 's', phoneKey: randomBytes(32),
      initialAdminLogin: 'admin', initialAdminPassword: '', bitrixWebhookUrl: 'https://test.bitrix24.ru/rest/1/hook/',
      bitrixOutgoingToken: '', uisAccessToken: '', uisHookKey: '', tz: 'Europe/Moscow', demo: false,
    };
    ({ app, ctx } = await buildApp(config, db, { bx: new BitrixClient(config.bitrixWebhookUrl, fakeBitrix, 0), uis: new UisCallApi('') }));
    await app.ready();
    ctx.scheduler.stop();

    await login('admin', 'admin-password-1');
    const roles = (await req('admin', 'GET', '/api/roles')).body.items as { id: number; name: string }[];
    const role = (n: string) => roles.find((r) => r.name === n)!.id;
    for (const [who, name, r] of [['op1', 'Ольга', 'Оператор ОКЦ'], ['op2', 'Пётр', 'Оператор ОКЦ'], ['sup', 'Сергей', 'Супервайзер ОКЦ']]) {
      ids[who] = (await req('admin', 'POST', '/api/users', { login: who, name, password: `${who}-password-1`, roleId: role(r) })).body.id;
      await login(who, `${who}-password-1`);
    }
    const okc = await getSetting(db, 'okc');
    await req('admin', 'PUT', '/api/settings/okc', {
      ...okc,
      bitrix: { ...okc.bitrix, categoryId: 7, stageMeeting: 'C7:NEW', stagesDone: ['C7:WON'], stagesFailed: ['C7:LOSE'], meetingAtField: 'UF_CRM_MEET',
        calendarOp: { type: 'company_calendar', ownerId: 1, sectionId: 11 }, calendarOup: { type: 'company_calendar', ownerId: 1, sectionId: 22 } },
    });
    expect((await req('admin', 'PUT', '/api/okc/prices', { office: 1500, dks: 1000 })).status).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('супервайзер загружает базу: дубли и мусор пропускаются', async () => {
    expect((await req('op1', 'POST', '/api/okc/base', { text: '79130000001' })).status).toBe(403);
    const r = await req('sup', 'POST', '/api/okc/base', { name: 'Тест', text: 'Телефон\n8 913 000-00-01\n+79130000002\n79130000002\nabc123\n9130000003\n9130000004' });
    expect(r.body).toMatchObject({ added: 4, duplicates: 1, invalid: 1 });
    const again = await req('sup', 'POST', '/api/okc/base', { text: '79130000001' });
    expect(again.body).toMatchObject({ added: 0, duplicates: 1 });
  });

  it('карточки получают только операторы в статусе «Готов», каждый — свою', async () => {
    expect((await req('op1', 'POST', '/api/okc/next', {})).status).toBe(409);
    await req('op1', 'POST', '/api/okc/status', { status: 'ready' });
    await req('op2', 'POST', '/api/okc/status', { status: 'ready' });
    ids.a = (await next('op1'))!;
    ids.b = (await next('op2'))!;
    expect(ids.a).not.toBe(ids.b);
    expect(await next('op1')).toBe(ids.a);
    const card = (await req('op1', 'GET', `/api/okc/cards/${ids.a}`)).body;
    expect(card.phone).toBe('+7 ••• ••• •• 01');
    expect((await req('op2', 'POST', `/api/okc/cards/${ids.a}/later`, {})).status).toBe(403);
  });

  it('позвонить позднее: карточка закреплена и вернётся через час', async () => {
    expect((await req('op1', 'POST', `/api/okc/cards/${ids.a}/comment`, { text: 'Просил перезвонить вечером' })).status).toBe(200);
    await req('op1', 'POST', `/api/okc/cards/${ids.a}/later`, {});
    ids.c = (await next('op1'))!;
    expect(ids.c).not.toBe(ids.a);
    const { rows } = await db.query('SELECT status, owner_id, available_at > now() + interval \'50 minutes\' AS later FROM okc_cards WHERE id = $1', [ids.a]);
    expect(rows[0]).toMatchObject({ status: 'later', owner_id: ids.op1, later: true });
    // Другой оператор видит комментарии в истории карточки
    await db.query("UPDATE okc_cards SET available_at = now() WHERE id = $1", [ids.a]);
    const view = (await req('sup', 'GET', `/api/okc/cards/${ids.a}`)).body;
    expect(view.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['comment', 'later']));
    await db.query("UPDATE okc_cards SET available_at = now() + interval '1 hour' WHERE id = $1", [ids.a]);
  });

  it('отказ с причиной убирает карточку из обзвона, супервайзер возвращает её в работу', async () => {
    const reasons = (await req('op2', 'GET', '/api/okc/reasons')).body.items;
    expect((await req('op2', 'POST', `/api/okc/cards/${ids.b}/refuse`, {})).status).toBe(400);
    await req('op2', 'POST', `/api/okc/cards/${ids.b}/refuse`, { reasonId: reasons[0].id });
    ids.d = (await next('op2'))!;
    expect(ids.d).not.toBe(ids.b);
    expect((await req('op2', 'POST', `/api/okc/cards/${ids.b}/return`, {})).status).toBe(403);
    expect((await req('sup', 'POST', `/api/okc/cards/${ids.b}/return`, {})).status).toBe(200);
    expect((await db.query('SELECT status FROM okc_cards WHERE id = $1', [ids.b])).rows[0].status).toBe('new');
  });

  it('есть договорённость: в разделе оператора, закреплена за ним', async () => {
    await req('op2', 'POST', `/api/okc/cards/${ids.d}/agreement`, { at: inDays(1, 12) });
    const my = (await req('op2', 'GET', '/api/okc/my?section=agreement')).body.items;
    expect(my.map((c: { id: number }) => c.id)).toEqual([ids.d]);
  });

  it('согласен на встречу: офисная завтра — сделка в воронке ОКЦ, календарь ОП, дело за 3 часа', async () => {
    calls.length = 0;
    expect((await req('op1', 'POST', `/api/okc/cards/${ids.c}/meeting`, { at: inDays(2, 15), type: 'office', region: 'city' })).status).toBe(400);
    const r = await req('op1', 'POST', `/api/okc/cards/${ids.c}/meeting`, { at: inDays(2, 15), type: 'office', region: 'city', clientName: 'Иван Петров', comment: 'Интересует остекление' });
    expect(r.status).toBe(200);
    expect(r.body.deal).toMatchObject({ ok: true });
    expect(new Date(r.body.reminderAt).getTime()).toBe(new Date(inDays(2, 15)).getTime() - 3 * 3_600_000);
    const deal = calls.find((c) => c.method === 'crm.deal.add')!.body;
    expect(deal).toContain('fields[CATEGORY_ID]=7');
    expect(deal).toContain('fields[STAGE_ID]=C7:NEW');
    expect(deal).toContain('fields[COMMENTS]=Интересует остекление');
    expect(deal).toContain('fields[UF_CRM_MEET]=');
    expect(calls.find((c) => c.method === 'calendar.event.add')!.body).toContain('section=11');
    const my = (await req('op1', 'GET', '/api/okc/my?section=meeting')).body.items;
    expect(my[0]).toMatchObject({ id: ids.c, meetingType: 'office' });
    expect((await req('op1', 'GET', '/api/okc/tasks')).body.items).toHaveLength(1);
  });

  it('ДКС не Пермский край — календарь ОУП, без дела; «не состоялась» возвращает оператору', async () => {
    const e = (await next('op1'))!;
    calls.length = 0;
    const r = await req('op1', 'POST', `/api/okc/cards/${e}/meeting`, { at: inDays(3, 11), type: 'dks', region: 'outside', clientName: 'Анна' });
    expect(r.body.reminderAt).toBeNull();
    expect(calls.find((c) => c.method === 'calendar.event.add')!.body).toContain('section=22');
    ids.e = e;
    const dealOf = async (id: number) => String((await db.query('SELECT bitrix_deal_id FROM okc_cards WHERE id = $1', [id])).rows[0].bitrix_deal_id);
    dealStages.set(await dealOf(ids.c), 'C7:WON');
    dealStages.set(await dealOf(ids.e), 'C7:LOSE');
    expect(await syncMeetingStages(db, ctx.bx, ctx.log)).toEqual({ done: 1, failed: 1 });
    const st = await db.query('SELECT id, status, owner_id FROM okc_cards WHERE id = ANY($1) ORDER BY id', [[ids.c, ids.e]]);
    expect(st.rows.find((x) => x.id === ids.c).status).toBe('meeting_done');
    expect(st.rows.find((x) => x.id === ids.e)).toMatchObject({ status: 'meeting_failed', owner_id: ids.op1 });
    expect((await req('op1', 'GET', '/api/okc/tasks')).body.items).toHaveLength(0);
    expect(await next('op1')).toBe(ids.e);
  });

  it('бонус: только за состоявшуюся встречу, вывод через одобрение администратора', async () => {
    const b = (await req('op1', 'GET', '/api/okc/bonus')).body;
    expect(b.summary).toMatchObject({ accrued: 1500, available: 1500 });
    expect((await req('op1', 'POST', '/api/okc/bonus/withdraw', { amount: 2000 })).status).toBe(400);
    const w1 = (await req('op1', 'POST', '/api/okc/bonus/withdraw', { amount: 1000 })).body.id;
    expect((await req('op1', 'GET', '/api/okc/bonus')).body.summary.available).toBe(500);
    expect((await req('admin', 'GET', '/api/me')).body.pendingPayouts).toBe(1);
    expect((await req('admin', 'POST', `/api/okc/withdrawals/${w1}`, { approve: false })).status).toBe(400);
    await req('admin', 'POST', `/api/okc/withdrawals/${w1}`, { approve: false, comment: 'Неверные реквизиты' });
    expect((await req('op1', 'GET', '/api/okc/bonus')).body.summary.available).toBe(1500);
    const w2 = (await req('op1', 'POST', '/api/okc/bonus/withdraw', { amount: 1500 })).body.id;
    await req('admin', 'POST', `/api/okc/withdrawals/${w2}`, { approve: true });
    const after = (await req('op1', 'GET', '/api/okc/bonus')).body;
    expect(after.summary).toMatchObject({ available: 0, withdrawn: 1500 });
    expect(after.withdrawals.map((w: { status: string }) => w.status).sort()).toEqual(['approved', 'rejected']);
  });

  it('перерыв: карточки не выдаются, время считается', async () => {
    await req('op2', 'POST', '/api/okc/status', { status: 'break' });
    expect((await req('op2', 'POST', '/api/okc/next', {})).status).toBe(409);
    const me = (await req('op2', 'GET', '/api/okc/me')).body;
    expect(me.status).toBe('break');
    await req('op2', 'POST', '/api/okc/status', { status: 'ready' });
  });

  it('открепление: позвонить позднее — после 5 дней без входа, договорённость — после 7', async () => {
    const s = await getSetting(db, 'okc');
    await db.query("UPDATE users SET last_seen_at = now() - interval '6 days' WHERE id = ANY($1)", [[ids.op1, ids.op2]]);
    await db.query('UPDATE okc_cards SET current_user_id = NULL WHERE current_user_id = ANY($1)', [[ids.op1, ids.op2]]);
    await autoRelease(db, s);
    const rows = (await db.query('SELECT id, status, owner_id FROM okc_cards WHERE id = ANY($1)', [[ids.a, ids.d]])).rows;
    expect(rows.find((r) => r.id === ids.a)).toMatchObject({ status: 'new', owner_id: null });
    expect(rows.find((r) => r.id === ids.d)).toMatchObject({ status: 'agreement', owner_id: ids.op2 });
    await db.query("UPDATE users SET last_seen_at = now() - interval '8 days' WHERE id = $1", [ids.op2]);
    await autoRelease(db, s);
    expect((await db.query('SELECT status, owner_id FROM okc_cards WHERE id = $1', [ids.d])).rows[0]).toMatchObject({ status: 'new', owner_id: null });
  });

  it('супервайзер снимает все карточки с оператора', async () => {
    expect((await req('sup', 'POST', `/api/okc/operators/${ids.op1}/release`, {})).body.released).toBeGreaterThan(0);
    expect((await db.query('SELECT count(*)::int AS n FROM okc_cards WHERE owner_id = $1 AND status IN (\'later\', \'agreement\', \'meeting_failed\')', [ids.op1])).rows[0].n).toBe(0);
  });

  it('статистика: встречи и конверсии, оператор видит только себя', async () => {
    const all = (await req('sup', 'GET', '/api/okc/stats')).body;
    expect(all.total).toMatchObject({ meetings: 2, done: 1, failed: 1, refused: 1 });
    expect(all.total.doneOfMeetings).toBe(50);
    const own = (await req('op2', 'GET', '/api/okc/stats')).body;
    expect(own.total.meetings).toBe(0);
    expect(own.operators.every((o: { userId: number }) => o.userId === ids.op2)).toBe(true);
  });
});
