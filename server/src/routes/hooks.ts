import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { AppContext } from '../app.js';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Нормализует уведомление UIS: поля шаблона уведомления задаются в кабинете UIS (docs/uis-setup.md). */
export function parseUisNotification(body: Record<string, unknown>) {
  const session = Number(body.call_session_id);
  const event = String(body.event ?? body.notification_name ?? '').toLowerCase();
  const talk = Number(body.talk_time_duration ?? body.talk_duration ?? 0) || 0;
  const records = [body.call_records, body.record_id, body.file_link]
    .flat()
    .filter((v): v is string | number => (typeof v === 'string' && v.length > 0) || typeof v === 'number')
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  let status: 'talk' | 'ended' | 'missed' | null = null;
  if (/talk|answer|разговор/.test(event)) status = 'talk';
  else if (/miss|lost|пропущ|неотвеч/.test(event)) status = 'missed';
  else if (/end|finish|заверш/.test(event)) status = 'ended';
  return { session: Number.isFinite(session) && session > 0 ? session : null, status, talk, records };
}

export async function hookRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, config } = ctx;

  // Исходящий вебхук Битрикс24 на событие ONCRMACTIVITYADD: проверяем токен и запускаем синхронизацию
  app.post('/hooks/bitrix', async (req, reply) => {
    const body = (req.body ?? {}) as { auth?: { application_token?: string }; event?: string };
    const token = body.auth?.application_token ?? '';
    if (!config.bitrixOutgoingToken || !same(token, config.bitrixOutgoingToken)) return reply.code(403).send({ error: 'forbidden' });
    // Новое дело — загрузка клиентов ОКК, изменение сделки — проверка стадий встреч ОКЦ
    ctx.scheduler.triggerSync();
    if (String(body.event ?? '').toUpperCase() === 'ONCRMDEALUPDATE') ctx.scheduler.triggerOkcSync();
    return { ok: true };
  });

  // Уведомления UIS о звонках: адрес содержит секрет UIS_HOOK_KEY
  app.post('/hooks/uis/:key', async (req, reply) => {
    const key = (req.params as { key: string }).key;
    if (!config.uisHookKey || !same(key, config.uisHookKey)) return reply.code(403).send({ error: 'forbidden' });
    const n = parseUisNotification((req.body ?? {}) as Record<string, unknown>);
    if (!n.session) return { ok: true, ignored: true };
    // Звонки ОКК и ОКЦ: сессия UIS уникальна, обновится только одна таблица
    for (const table of ['calls', 'okc_calls']) {
      if (n.status === 'talk') {
        await db.query(`UPDATE ${table} SET status = 'talk' WHERE uis_session_id = $1 AND status IN ('starting', 'ringing')`, [n.session]);
      } else if (n.status) {
        await db.query(
          `UPDATE ${table} SET status = $2, ended_at = COALESCE(ended_at, now()), talk_seconds = GREATEST(COALESCE(talk_seconds, 0), $3),
                  record_ids = (SELECT array_agg(DISTINCT x) FROM unnest(record_ids || $4::text[]) x)
            WHERE uis_session_id = $1`,
          [n.session, n.status === 'missed' ? 'missed' : 'ended', n.talk, n.records],
        );
      }
    }
    return { ok: true };
  });
}
