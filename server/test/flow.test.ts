// Сквозной сценарий на настоящей PostgreSQL. Нужна пустая база в TEST_DATABASE_URL, иначе тест пропускается.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppContext } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { seedUsers } from '../src/db/users.js';
import { BitrixClient } from '../src/bitrix/client.js';
import { UisCallApi } from '../src/uis/callApi.js';
import { returnDueCallbacks } from '../src/cards/service.js';
import type { Config } from '../src/config.js';

const url = process.env.TEST_DATABASE_URL;
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

/** Битрикс24 понарошку: одно дело-триггер, сделка с контактом, создание лида. */
const bitrixCalls: { method: string; body: string }[] = [];
const fakeBitrix = (async (u: string, init: RequestInit) => {
  const method = u.replace('https://test.bitrix24.ru/rest/1/hook/', '').replace('.json', '');
  bitrixCalls.push({ method, body: String(init.body) });
  switch (method) {
    case 'crm.activity.list':
      return json({ result: [{ ID: '901', OWNER_ID: '48213', OWNER_TYPE_ID: '2', SUBJECT: 'ОКК: опрос после встречи', RESPONSIBLE_ID: '12', PROVIDER_ID: 'CRM_TODO' }] });
    case 'crm.deal.get':
      return json({ result: { ID: '48213', TITLE: 'Остекление балкона', CONTACT_ID: '77', CATEGORY_ID: '0', STAGE_ID: 'WON', OPPORTUNITY: '86400', ASSIGNED_BY_ID: '9', CURRENCY_ID: 'RUB' } });
    case 'crm.contact.get':
      return json({ result: { NAME: 'Елена', LAST_NAME: 'Смирнова', SECOND_NAME: 'Викторовна', PHONE: [{ VALUE: '+7 (913) 111-22-47', VALUE_TYPE: 'MOBILE' }] } });
    case 'crm.deal.fields':
      return json({ result: { TITLE: { type: 'string', title: 'Название' }, OPPORTUNITY: { type: 'double', title: 'Сумма' }, ASSIGNED_BY_ID: { type: 'user', title: 'Ответственный' } } });
    case 'crm.status.list':
      return json({ result: [] });
    case 'user.get':
      return json({ result: [{ ID: '9', NAME: 'Алексей', LAST_NAME: 'Петров' }] });
    case 'crm.duplicate.findbycomm':
      return json({ result: [] });
    case 'crm.lead.add':
      return json({ result: 5501 });
    default:
      return json({ error: 'ERROR_METHOD_NOT_FOUND', error_description: method });
  }
}) as typeof fetch;

const fakeUis = (async () => json({ jsonrpc: '2.0', id: 1, result: { data: { call_session_id: 3001 } } })) as typeof fetch;

describe.skipIf(!url)('сквозной сценарий обзвона', () => {
  let db: pg.Pool;
  let app: FastifyInstance;
  let ctx: AppContext;
  const cookies: Record<string, string> = {};

  const req = async (who: string, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) => {
    const res = await app.inject({
      method, url: path,
      headers: { ...(cookies[who] ? { cookie: cookies[who] } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.statusCode, body: res.headers['content-type']?.toString().includes('json') ? res.json() : res.body, headers: res.headers };
  };

  const login = async (who: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ login: who, password }) });
    expect(res.statusCode).toBe(200);
    cookies[who] = String(res.headers['set-cookie']).split(';')[0];
  };

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await seedUsers(db, { login: 'admin', password: 'admin-password-1' });
    const config: Config = {
      port: 0, publicUrl: 'https://okk.test', databaseUrl: url!, sessionSecret: 'test-secret', phoneKey: randomBytes(32),
      initialAdminLogin: 'admin', initialAdminPassword: '', bitrixWebhookUrl: 'https://test.bitrix24.ru/rest/1/hook/',
      bitrixOutgoingToken: 'out-token', uisAccessToken: 'uis', uisHookKey: 'uis-hook', tz: 'Europe/Moscow', demo: false,
    };
    ({ app, ctx } = await buildApp(config, db, {
      bx: new BitrixClient(config.bitrixWebhookUrl, fakeBitrix, 0),
      uis: new UisCallApi('uis', fakeUis),
    }));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('без входа API закрыт, чужой сайт не может менять данные', async () => {
    expect((await req('nobody', 'GET', '/api/queue')).status).toBe(401);
    const res = await app.inject({ method: 'POST', url: '/api/login', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(403);
  });

  it('администратор настраивает кабинет и заводит оператора', async () => {
    await login('admin', 'admin-password-1');
    const roles = (await req('admin', 'GET', '/api/roles')).body as { items: { id: number; name: string }[] };
    const operatorRole = roles.items.find((r) => r.name === 'Оператор')!.id;
    expect((await req('admin', 'POST', '/api/users', { login: 'anna', name: 'Анна Котова', password: 'anna-password-1', roleId: operatorRole, uisEmployeeId: 55 })).status).toBe(200);

    const survey = (await req('admin', 'POST', '/api/surveys', { name: 'NPS после встречи', starter: true })).body as { id: number };
    expect((await req('admin', 'POST', `/api/surveys/${survey.id}/publish`)).body).toEqual({ version: 1 });

    expect((await req('admin', 'PUT', '/api/settings/source', { enabled: true, responsibleIds: [12], sinceDate: '2026-10-01' })).status).toBe(200);
    expect((await req('admin', 'PUT', '/api/settings/uis', { virtualNumber: '8 495 123-45-67' })).status).toBe(200);
    const sync = (await req('admin', 'POST', '/api/sync', {})).body as { imported: number };
    expect(sync.imported).toBe(1);
    // Повторная синхронизация то же дело не дублирует
    expect(((await req('admin', 'POST', '/api/sync', {})).body as { imported: number }).imported).toBe(0);
  });

  it('оператор видит клиента без номера, администратор — с номером', async () => {
    await login('anna', 'anna-password-1');
    const queue = (await req('anna', 'GET', '/api/queue')).body as { items: { id: number; clientName: string; phoneTail: string }[] };
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({ clientName: 'Смирнова Елена Викторовна', phoneTail: '47' });
    const id = queue.items[0].id;

    const asOperator = await req('anna', 'GET', `/api/cards/${id}`);
    expect(asOperator.body.phone).toBe('+7 ••• ••• •• 47');
    expect(JSON.stringify(asOperator.body)).not.toContain('1112247');
    expect(asOperator.body.dealUrl).toBeNull();
    expect(asOperator.body.fields).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Менеджер', value: 'Алексей Петров' })]));
    expect((await req('anna', 'GET', `/api/cards/${id}/phone`)).status).toBe(403);

    const asAdmin = await req('admin', 'GET', `/api/cards/${id}`);
    expect(asAdmin.body.phone).toBe('+7 913 111-22-47');
    expect(asAdmin.body.dealUrl).toBe('https://test.bitrix24.ru/crm/deal/details/48213/');
  });

  it('«подумает, перезвонить»: карточка уходит в перезвон и возвращается за 15 минут', async () => {
    const id = ((await req('anna', 'GET', '/api/queue')).body as { items: { id: number }[] }).items[0].id;
    expect((await req('anna', 'POST', `/api/cards/${id}/open`, {})).status).toBe(200);
    const call = await req('anna', 'POST', `/api/cards/${id}/call`, {});
    expect(call.body).toMatchObject({ status: 'ringing' });

    const card = (await req('anna', 'GET', `/api/cards/${id}`)).body;
    const at = new Date(Date.now() + 2 * 3_600_000);
    const noTime = await req('anna', 'POST', `/api/cards/${id}/response`, { versionId: card.survey.versionId, answers: { nps: 8, partner: 'later' } });
    expect(noTime.status).toBe(400);
    const saved = await req('anna', 'POST', `/api/cards/${id}/response`, { versionId: card.survey.versionId, answers: { nps: 8, partner: 'later' }, callbackAt: at.toISOString() });
    expect(saved.body.outcome).toBe('callback');
    expect(((await req('anna', 'GET', '/api/queue')).body as { items: unknown[] }).items).toHaveLength(0);

    // За 20 минут до перезвона — ещё рано, за 14 — пора
    expect(await returnDueCallbacks(db, new Date(at.getTime() - 20 * 60_000))).toBe(0);
    expect(await returnDueCallbacks(db, new Date(at.getTime() - 14 * 60_000))).toBe(1);

    const queue = (await req('anna', 'GET', '/api/queue')).body as { items: { id: number; repeat: boolean }[] };
    expect(queue.items[0]).toMatchObject({ id, repeat: true });
    const again = (await req('anna', 'GET', `/api/cards/${id}`)).body;
    expect(again.statusLabel).toBe('Повторный звонок');
    expect(again.draftAnswers).toMatchObject({ nps: 8, partner: 'later' });
    expect(again.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['callback_scheduled', 'callback_due', 'call_started']));
  });

  it('повторный звонок: рекомендация уходит лидом, анкета остаётся у нас', async () => {
    const id = ((await req('anna', 'GET', '/api/queue')).body as { items: { id: number }[] }).items[0].id;
    await req('anna', 'POST', `/api/cards/${id}/open`, {});
    const card = (await req('anna', 'GET', `/api/cards/${id}`)).body;
    bitrixCalls.length = 0;
    const saved = await req('anna', 'POST', `/api/cards/${id}/response`, {
      versionId: card.survey.versionId,
      answers: { nps: 10, good: ['g1', 'g2'], comment: 'Всё отлично', partner: 'yes', referral: [{ name: 'Игорь', phone: '8 913 555-66-77', comment: 'Окна на дачу' }] },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ outcome: 'done', leads: [{ ok: true, leadId: 5501 }] });

    // В Битрикс24 ушёл только лид; ответы анкеты туда не передаются
    expect(bitrixCalls.map((c) => c.method)).not.toContain('crm.deal.update');
    const lead = decodeURIComponent(bitrixCalls.find((c) => c.method === 'crm.lead.add')!.body);
    expect(lead).toContain('+79135556677');
    expect(lead).not.toContain('Всё отлично');

    // Одна анкета на карточку: после перезвона дописана та же запись
    const { rows } = await db.query('SELECT answers, outcome FROM responses');
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('done');
    expect(JSON.stringify(rows[0].answers)).not.toContain('5556677');

    const view = (await req('anna', 'GET', `/api/cards/${id}`)).body;
    expect(view.referrals[0]).toMatchObject({ name: 'Игорь', phone: '+7 ••• ••• •• 77', leadId: 5501 });
    const adminView = (await req('admin', 'GET', `/api/cards/${id}`)).body;
    expect(adminView.referrals[0].phone).toBe('+7 913 555-66-77');
  });

  it('дашборд и выгрузка', async () => {
    const d = (await req('admin', 'GET', '/api/dashboard')).body;
    expect(d.kpis).toMatchObject({ nps: 100, responses: 1, promoters: 1, referrals: 1, leadsSent: 1, calls: 1 });
    expect(d.distribution[10]).toBe(1);
    // Оператор видит только свою статистику, выгрузка ему недоступна
    expect((await req('anna', 'GET', '/api/dashboard')).status).toBe(200);
    expect((await req('anna', 'GET', '/api/reports/responses.csv')).status).toBe(403);
    const csv = await req('admin', 'GET', '/api/reports/responses.csv');
    expect(csv.body).toContain('Смирнова Елена Викторовна');
    expect(csv.body).toContain('Игорь (••77)');
  });

  it('права: администратор выдаёт оператору прослушивание своих звонков', async () => {
    const users = (await req('admin', 'GET', '/api/users')).body as { items: { id: number; login: string }[] };
    const anna = users.items.find((u) => u.login === 'anna')!;
    expect((await req('admin', 'PUT', `/api/users/${anna.id}`, { grant: ['recordings.own'] })).status).toBe(200);
    const me = (await req('anna', 'GET', '/api/me')).body as { permissions: string[] };
    expect(me.permissions).toContain('recordings.own');
    // Блокировка сразу закрывает сессию
    await req('admin', 'PUT', `/api/users/${anna.id}`, { active: false });
    expect((await req('anna', 'GET', '/api/me')).status).toBe(401);
  });

  it('вебхук Битрикс24 принимает только свой токен', async () => {
    const bad = await app.inject({ method: 'POST', url: '/hooks/bitrix', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'event=ONCRMACTIVITYADD&auth[application_token]=wrong' });
    expect(bad.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/hooks/bitrix', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'event=ONCRMACTIVITYADD&auth[application_token]=out-token' });
    expect(ok.statusCode).toBe(200);
    ctx.scheduler.stop();
  });
});
