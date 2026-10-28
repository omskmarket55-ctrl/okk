import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist');

/** Одностраничное приложение: всё, что не API, отдаёт index.html. */
export async function webRoutes(app: FastifyInstance) {
  const index = path.join(WEB_DIST, 'index.html');
  app.get('/', async (_req, reply) => {
    if (!existsSync(index)) return reply.type('text/plain; charset=utf-8').send('Фронтенд не собран: npm run build');
    reply.header('Cache-Control', 'no-cache');
    return reply.type('text/html; charset=utf-8').send(await readFile(index, 'utf8'));
  });
}
