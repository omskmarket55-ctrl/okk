import Fastify, { type FastifyBaseLogger } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import qs from 'qs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import { HttpError, makeGuard, type Guard } from './auth/guard.js';
import { BitrixClient } from './bitrix/client.js';
import { DealDirectory } from './bitrix/deals.js';
import { UisCallApi } from './uis/callApi.js';
import { Scheduler } from './sync/scheduler.js';
import { authRoutes } from './routes/auth.js';
import { cardRoutes } from './routes/cards.js';
import { surveyRoutes } from './routes/surveys.js';
import { adminRoutes } from './routes/admin.js';
import { reportRoutes } from './routes/reports.js';
import { hookRoutes } from './routes/hooks.js';
import { okcRoutes } from './routes/okc.js';
import { WEB_DIST, webRoutes } from './routes/web.js';

export interface AppContext {
  config: Config;
  db: Db;
  need: Guard;
  bx: BitrixClient;
  dir: DealDirectory;
  uis: UisCallApi;
  scheduler: Scheduler;
  log: FastifyBaseLogger;
}

export interface AppDeps {
  bx?: BitrixClient;
  uis?: UisCallApi;
}

export async function buildApp(config: Config, db: Db, deps: AppDeps = {}) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true, bodyLimit: 1_000_000 });
  await app.register(cookie);
  // Исходящий вебхук Битрикс24 шлёт форму с вложенными ключами: auth[application_token], data[FIELDS][ID]
  await app.register(formbody, { parser: (body) => qs.parse(body, { depth: 5 }) });

  // Защита от подделки запросов с чужих сайтов: изменения в API — только JSON и только со своего адреса
  const ownOrigin = new URL(config.publicUrl).origin;
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin && origin !== ownOrigin && !config.demo) return reply.code(403).send({ error: 'bad_origin', message: 'Запрос с чужого сайта' });
    if (req.headers['content-length'] !== '0' && req.headers['content-length'] && !String(req.headers['content-type']).startsWith('application/json')) {
      return reply.code(415).send({ error: 'json_only', message: 'Ожидается JSON' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      const extra = err as HttpError & { errors?: unknown; problems?: unknown };
      return reply.code(err.status).send({ error: err.code, message: err.message, errors: extra.errors, problems: extra.problems });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'bad_request', message: e.message });
    req.log.error({ err }, 'Ошибка запроса');
    return reply.code(500).send({ error: 'internal', message: 'Внутренняя ошибка сервера. Попробуйте ещё раз' });
  });

  const bx = deps.bx ?? new BitrixClient(config.bitrixWebhookUrl);
  const dir = new DealDirectory(bx);
  const uis = deps.uis ?? new UisCallApi(config.uisAccessToken);
  const scheduler = new Scheduler(db, bx, dir, config.phoneKey, app.log);
  const ctx: AppContext = { config, db, need: makeGuard(db, config.sessionSecret), bx, dir, uis, scheduler, log: app.log };

  if (existsSync(path.join(WEB_DIST, 'assets'))) {
    await app.register(fastifyStatic, { root: path.join(WEB_DIST, 'assets'), prefix: '/assets/', maxAge: '7d', immutable: true });
  }
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
  });
  app.get('/health', async () => ({ ok: true }));
  await webRoutes(app);
  await authRoutes(app, ctx);
  await cardRoutes(app, ctx);
  await surveyRoutes(app, ctx);
  await adminRoutes(app, ctx);
  await reportRoutes(app, ctx);
  await hookRoutes(app, ctx);
  await okcRoutes(app, ctx);
  return { app, ctx };
}
