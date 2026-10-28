import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../app.js';
import { HttpError, can } from '../auth/guard.js';
import { audit } from '../db/users.js';
import { dashboard } from '../reports/dashboard.js';
import { visibleQuestions, type SurveySchema } from '../surveys/schema.js';

/** Период из запроса: from/to в формате ГГГГ-ММ-ДД, по умолчанию — последние 30 дней. to включительно. */
export function parsePeriod(q: { from?: string; to?: string }, now = new Date()) {
  const day = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : null);
  const to = day(q.to) ?? new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from = day(q.from) ?? new Date(to.getTime() - 29 * 86_400_000);
  if (from > to) throw new HttpError(400, 'bad_period', 'Начало периода позже конца');
  return { from, to: new Date(to.getTime() + 86_400_000) };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Формулы в Excel не исполняем: ячейки, начинающиеся с =, +, -, @, экранируем
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[";\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export async function reportRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, need } = ctx;

  const scope = (req: FastifyRequest, user: Awaited<ReturnType<typeof need>>) => {
    const q = req.query as { userId?: string };
    if (!can(user, 'reports.all')) return user.id;
    return q.userId ? Number(q.userId) : undefined;
  };

  app.get('/api/dashboard', async (req) => {
    const user = await need(req, 'reports.all', 'reports.own');
    const p = parsePeriod(req.query as { from?: string; to?: string });
    return dashboard(db, { ...p, userId: scope(req, user) });
  });

  // Выгрузка анкет в CSV (открывается в Excel): одна строка — одна анкета, столбцы — вопросы
  app.get('/api/reports/responses.csv', async (req, reply) => {
    const user = await need(req, 'reports.export');
    const p = parsePeriod(req.query as { from?: string; to?: string });
    const { rows } = await db.query<{ id: number; card_id: number; deal_id: string; client_name: string; nps: number | null; outcome: string; answers: Record<string, unknown>; schema: SurveySchema; user_name: string | null; updated_at: Date }>(
      `SELECT r.id, r.card_id, c.deal_id, c.client_name, r.nps, r.outcome, r.answers, v.schema, u.name AS user_name, r.updated_at
         FROM responses r JOIN cards c ON c.id = r.card_id JOIN survey_versions v ON v.id = r.survey_version_id
         LEFT JOIN users u ON u.id = r.user_id WHERE r.updated_at >= $1 AND r.updated_at < $2 ORDER BY r.updated_at`,
      [p.from, p.to],
    );
    const titles: string[] = [];
    for (const r of rows) for (const q of r.schema.questions) if (q.type !== 'info' && !titles.includes(q.title)) titles.push(q.title);
    const header = ['Дата', 'Клиент', 'Сделка', 'Сотрудник', 'Итог', 'NPS', ...titles];
    const outcome: Record<string, string> = { done: 'Заполнена', callback: 'Перезвон', refused: 'Отказ' };
    const lines = rows.map((r) => {
      const byTitle = new Map<string, string>();
      for (const q of visibleQuestions(r.schema, r.answers as never)) {
        const a = r.answers[q.id];
        if (a === undefined) continue;
        let text: string;
        if (q.type === 'single' || q.type === 'multi') text = [a].flat().map((id) => q.options?.find((o) => o.id === id)?.label ?? id).join(', ');
        else if (q.type === 'yesno') text = a ? 'Да' : 'Нет';
        else if (q.type === 'referral') text = (a as { name: string; phoneTail: string }[]).map((x) => `${x.name} (••${x.phoneTail})`).join(', ');
        else text = String(a);
        byTitle.set(q.title, text);
      }
      return [r.updated_at.toLocaleString('ru-RU'), r.client_name, r.deal_id, r.user_name, outcome[r.outcome] ?? r.outcome, r.nps, ...titles.map((t) => byTitle.get(t) ?? '')]
        .map(csvCell).join(';');
    });
    await audit(db, user.id, 'export', 'responses', { from: p.from, to: p.to, rows: rows.length }, req.ip);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="okk-responses.csv"`);
    return '﻿' + [header.map(csvCell).join(';'), ...lines].join('\r\n');
  });
}
