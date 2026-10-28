import type { Db } from '../db/pool.js';
import { npsGroup, npsScore, type SurveySchema } from '../surveys/schema.js';

export interface Period {
  from: Date;
  to: Date;
  /** Только анкеты этого сотрудника (право «своя статистика») */
  userId?: number;
}

interface ResponseRow {
  id: number;
  card_id: number;
  nps: number | null;
  outcome: string;
  answers: Record<string, unknown>;
  schema: SurveySchema;
  user_id: number | null;
  user_name: string | null;
  client_name: string;
  created_at: Date;
}

/** Понедельник недели, в которую попала дата (в UTC — для группировки достаточно). */
export function weekStart(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

/** Сводка по варианту ответа в разрезе групп NPS. */
export function optionBreakdown(rows: Pick<ResponseRow, 'nps' | 'answers' | 'schema'>[]) {
  const byQuestion = new Map<string, { title: string; options: Map<string, { label: string; total: number; promoter: number; passive: number; detractor: number }> }>();
  for (const r of rows) {
    for (const q of r.schema.questions) {
      if (q.type !== 'single' && q.type !== 'multi' && q.type !== 'yesno') continue;
      const a = r.answers[q.id];
      if (a === undefined || a === null) continue;
      const key = q.title.trim().toLowerCase();
      let entry = byQuestion.get(key);
      if (!entry) byQuestion.set(key, (entry = { title: q.title, options: new Map() }));
      const labels = q.type === 'yesno'
        ? [a === true ? 'Да' : 'Нет']
        : [a].flat().map((id) => q.options?.find((o) => o.id === id)?.label ?? String(id));
      for (const label of labels) {
        let o = entry.options.get(label);
        if (!o) entry.options.set(label, (o = { label, total: 0, promoter: 0, passive: 0, detractor: 0 }));
        o.total++;
        if (r.nps !== null) o[npsGroup(r.nps)]++;
      }
    }
  }
  return [...byQuestion.values()].map((q) => ({ title: q.title, options: [...q.options.values()].sort((a, b) => b.total - a.total) }));
}

export async function dashboard(db: Db, p: Period) {
  const userFilter = p.userId ? 'AND r.user_id = $3' : '';
  const params: unknown[] = [p.from, p.to, ...(p.userId ? [p.userId] : [])];
  const { rows } = await db.query<ResponseRow>(
    `SELECT r.id, r.card_id, r.nps, r.outcome, r.answers, v.schema, r.user_id, u.name AS user_name, c.client_name, r.updated_at AS created_at
       FROM responses r JOIN survey_versions v ON v.id = r.survey_version_id JOIN cards c ON c.id = r.card_id
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.updated_at >= $1 AND r.updated_at < $2 ${userFilter}`,
    params,
  );
  const scored = rows.filter((r) => r.outcome === 'done' && r.nps !== null);
  const scores = scored.map((r) => r.nps as number);

  const callFilter = p.userId ? 'AND user_id = $3' : '';
  const calls = await db.query<{ n: string; answered: string; talk: string | null }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE talk_seconds > 0) AS answered, avg(talk_seconds) FILTER (WHERE talk_seconds > 0) AS talk
       FROM calls WHERE started_at >= $1 AND started_at < $2 ${callFilter}`,
    params,
  );
  const refFilter = p.userId ? 'AND r.user_id = $3' : '';
  const refs = await db.query<{ n: string; sent: string; errors: string }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE f.status = 'sent') AS sent, count(*) FILTER (WHERE f.status = 'error') AS errors
       FROM referrals f JOIN responses r ON r.id = f.response_id WHERE f.created_at >= $1 AND f.created_at < $2 ${refFilter}`,
    params,
  );
  const queue = await db.query<{ queued: string; callback: string; imported: string }>(
    `SELECT count(*) FILTER (WHERE status = 'queued') AS queued, count(*) FILTER (WHERE status = 'callback') AS callback,
            count(*) FILTER (WHERE created_at >= $1 AND created_at < $2) AS imported FROM cards`,
    [p.from, p.to],
  );

  const weeks = new Map<string, number[]>();
  for (const r of scored) {
    const w = weekStart(r.created_at);
    weeks.set(w, [...(weeks.get(w) ?? []), r.nps as number]);
  }
  const operators = new Map<number, { userId: number; name: string; responses: number; scores: number[]; referrals: number }>();
  for (const r of rows) {
    if (!r.user_id) continue;
    let o = operators.get(r.user_id);
    if (!o) operators.set(r.user_id, (o = { userId: r.user_id, name: r.user_name ?? '—', responses: 0, scores: [], referrals: 0 }));
    if (r.outcome === 'done') o.responses++;
    if (r.outcome === 'done' && r.nps !== null) o.scores.push(r.nps);
    for (const v of Object.values(r.answers)) if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] && 'phoneTail' in v[0]) o.referrals += v.length;
  }

  const commentOf = (r: ResponseRow) => {
    const q = r.schema.questions.find((x) => x.type === 'text');
    const a = q ? r.answers[q.id] : undefined;
    return typeof a === 'string' ? a : '';
  };

  return {
    kpis: {
      nps: npsScore(scores),
      responses: scored.length,
      promoters: scores.filter((s) => s >= 9).length,
      passives: scores.filter((s) => s >= 7 && s <= 8).length,
      detractors: scores.filter((s) => s <= 6).length,
      refused: rows.filter((r) => r.outcome === 'refused').length,
      callbacksPending: Number(queue.rows[0].callback),
      queued: Number(queue.rows[0].queued),
      imported: Number(queue.rows[0].imported),
      calls: Number(calls.rows[0].n),
      answeredCalls: Number(calls.rows[0].answered),
      avgTalkSeconds: calls.rows[0].talk ? Math.round(Number(calls.rows[0].talk)) : null,
      referrals: Number(refs.rows[0].n),
      leadsSent: Number(refs.rows[0].sent),
      leadErrors: Number(refs.rows[0].errors),
    },
    distribution: Array.from({ length: 11 }, (_, i) => scores.filter((s) => s === i).length),
    weekly: [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, s]) => ({ week, nps: npsScore(s), count: s.length })),
    operators: [...operators.values()]
      .map((o) => ({ userId: o.userId, name: o.name, responses: o.responses, nps: npsScore(o.scores), referrals: o.referrals }))
      .sort((a, b) => b.responses - a.responses),
    breakdown: optionBreakdown(scored),
    detractors: scored
      .filter((r) => (r.nps as number) <= 6)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, 50)
      .map((r) => ({ cardId: r.card_id, clientName: r.client_name, nps: r.nps, comment: commentOf(r), userName: r.user_name, at: r.created_at })),
  };
}
