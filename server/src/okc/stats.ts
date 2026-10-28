import type { Db } from '../db/pool.js';

export interface OkcStatsRow {
  userId: number | null;
  name: string;
  calls: number;
  dialed: number;
  meetings: number;
  done: number;
  failed: number;
  refused: number;
  breakSeconds: number;
}

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** Конверсии: в назначенную встречу от обзвоненных, в состоявшуюся от назначенных и от обзвоненных, % */
export function conversions(r: Pick<OkcStatsRow, 'dialed' | 'meetings' | 'done'>) {
  return { toMeeting: ratio(r.meetings, r.dialed), doneOfMeetings: ratio(r.done, r.meetings), doneOfDialed: ratio(r.done, r.dialed) };
}

/**
 * Статистика ОКЦ за период. Звонки — через UIS; «обзвонено» — карточки, по которым был звонок или итог
 * (позвонить позднее, договорённость, отказ, встреча). Встреча засчитывается оператору, который её назначил.
 */
export async function okcStats(db: Db, from: Date, to: Date, userId?: number) {
  const params: unknown[] = userId ? [from, to, userId] : [from, to];
  const userCond = (col: string) => (userId ? `AND ${col} = $3` : '');
  const opOf = `COALESCE((e.data->>'operatorId')::int, e.user_id)`;
  const { rows } = await db.query<{ uid: number | null; calls: string; dialed: string; meetings: string; done: string; failed: string; refused: string }>(
    `WITH ev AS (
       SELECT ${opOf} AS uid, e.type, e.card_id FROM okc_events e
        WHERE e.created_at >= $1 AND e.created_at < $2 AND e.type IN ('later', 'agreement', 'refused', 'meeting_set', 'meeting_done', 'meeting_failed', 'call')
        ${userCond(opOf)}
     ), calls AS (
       SELECT k.user_id AS uid, k.card_id FROM okc_calls k WHERE k.started_at >= $1 AND k.started_at < $2 ${userCond('k.user_id')}
     ), touched AS (
       SELECT uid, card_id FROM calls UNION SELECT uid, card_id FROM ev WHERE type IN ('later', 'agreement', 'refused', 'meeting_set')
     )
     SELECT u.uid,
            (SELECT count(*) FROM calls c WHERE c.uid IS NOT DISTINCT FROM u.uid) AS calls,
            (SELECT count(DISTINCT card_id) FROM touched t WHERE t.uid IS NOT DISTINCT FROM u.uid) AS dialed,
            (SELECT count(*) FROM ev WHERE ev.uid IS NOT DISTINCT FROM u.uid AND type = 'meeting_set') AS meetings,
            (SELECT count(*) FROM ev WHERE ev.uid IS NOT DISTINCT FROM u.uid AND type = 'meeting_done') AS done,
            (SELECT count(*) FROM ev WHERE ev.uid IS NOT DISTINCT FROM u.uid AND type = 'meeting_failed') AS failed,
            (SELECT count(*) FROM ev WHERE ev.uid IS NOT DISTINCT FROM u.uid AND type = 'refused') AS refused
       FROM (SELECT uid FROM ev UNION SELECT uid FROM calls) u`,
    params,
  );
  const breaks = await db.query<{ uid: number; s: string }>(
    `SELECT user_id AS uid, sum(extract(epoch FROM (LEAST(COALESCE(ended_at, now()), $2) - GREATEST(started_at, $1))))::int AS s
       FROM okc_status_log WHERE status = 'break' AND started_at < $2 AND COALESCE(ended_at, now()) > $1 ${userCond('user_id')}
      GROUP BY user_id`,
    params,
  );
  const names = await db.query<{ id: number; name: string }>('SELECT id, name FROM users');
  const nameOf = new Map(names.rows.map((u) => [u.id, u.name]));
  const breakOf = new Map(breaks.rows.map((b) => [b.uid, Number(b.s)]));
  const operators: OkcStatsRow[] = rows
    .filter((r) => r.uid !== null)
    .map((r) => ({
      userId: r.uid, name: nameOf.get(r.uid!) ?? '—', calls: Number(r.calls), dialed: Number(r.dialed), meetings: Number(r.meetings),
      done: Number(r.done), failed: Number(r.failed), refused: Number(r.refused), breakSeconds: breakOf.get(r.uid!) ?? 0,
    }));
  for (const [uid, s] of breakOf) if (!operators.some((o) => o.userId === uid)) operators.push({ userId: uid, name: nameOf.get(uid) ?? '—', calls: 0, dialed: 0, meetings: 0, done: 0, failed: 0, refused: 0, breakSeconds: s });
  const total = operators.reduce(
    (a, o) => ({ ...a, calls: a.calls + o.calls, dialed: a.dialed + o.dialed, meetings: a.meetings + o.meetings, done: a.done + o.done, failed: a.failed + o.failed, refused: a.refused + o.refused, breakSeconds: a.breakSeconds + o.breakSeconds }),
    { userId: null, name: 'Итого', calls: 0, dialed: 0, meetings: 0, done: 0, failed: 0, refused: 0, breakSeconds: 0 } as OkcStatsRow,
  );

  const daily = await db.query<{ day: string; calls: string; meetings: string; done: string }>(
    `WITH d AS (SELECT generate_series(date_trunc('day', $1::timestamptz), $2::timestamptz - interval '1 second', interval '1 day') AS day)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            (SELECT count(*) FROM okc_calls k WHERE k.started_at >= d.day AND k.started_at < d.day + interval '1 day' ${userCond('k.user_id')}) AS calls,
            (SELECT count(*) FROM okc_events e WHERE e.type = 'meeting_set' AND e.created_at >= d.day AND e.created_at < d.day + interval '1 day' ${userCond(opOf)}) AS meetings,
            (SELECT count(*) FROM okc_events e WHERE e.type = 'meeting_done' AND e.created_at >= d.day AND e.created_at < d.day + interval '1 day' ${userCond(opOf)}) AS done
       FROM d ORDER BY d.day`,
    params,
  );
  const base = await db.query<{ status: string; n: string }>('SELECT status, count(*) AS n FROM okc_cards GROUP BY status');

  return {
    total: { ...total, ...conversions(total) },
    operators: operators.sort((a, b) => b.meetings - a.meetings || b.calls - a.calls).map((o) => ({ ...o, ...conversions(o) })),
    daily: daily.rows.map((d) => ({ day: d.day, calls: Number(d.calls), meetings: Number(d.meetings), done: Number(d.done) })),
    base: Object.fromEntries(base.rows.map((b) => [b.status, Number(b.n)])),
  };
}
