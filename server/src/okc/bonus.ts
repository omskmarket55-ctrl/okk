import type { Db } from '../db/pool.js';
import { HttpError } from '../auth/guard.js';

/** Баланс: начислено минус заявки на вывод (ожидающие и одобренные). Отклонённые возвращаются в баланс. */
export async function bonusSummary(db: Db, userId: number) {
  const { rows } = await db.query<{ accrued: string; withdrawn: string; pending: string }>(
    `SELECT (SELECT COALESCE(sum(amount), 0) FROM okc_bonus_accruals WHERE user_id = $1) AS accrued,
            (SELECT COALESCE(sum(amount), 0) FROM okc_withdrawals WHERE user_id = $1 AND status = 'approved') AS withdrawn,
            (SELECT COALESCE(sum(amount), 0) FROM okc_withdrawals WHERE user_id = $1 AND status = 'pending') AS pending`,
    [userId],
  );
  const accrued = Number(rows[0].accrued);
  const withdrawn = Number(rows[0].withdrawn);
  const pending = Number(rows[0].pending);
  return { accrued, withdrawn, pending, available: Math.round((accrued - withdrawn - pending) * 100) / 100 };
}

export async function bonusHistory(db: Db, userId: number) {
  const [accruals, withdrawals] = await Promise.all([
    db.query(`SELECT a.id, a.amount::float AS amount, a.meeting_type AS "meetingType", a.created_at AS "createdAt", a.card_id AS "cardId",
                     c.client_name AS "clientName", c.meeting_at AS "meetingAt"
                FROM okc_bonus_accruals a JOIN okc_cards c ON c.id = a.card_id WHERE a.user_id = $1 ORDER BY a.created_at DESC`, [userId]),
    db.query(`SELECT w.id, w.amount::float AS amount, w.status, w.comment, w.created_at AS "createdAt", w.decided_at AS "decidedAt"
                FROM okc_withdrawals w WHERE w.user_id = $1 ORDER BY w.created_at DESC`, [userId]),
  ]);
  return { accruals: accruals.rows, withdrawals: withdrawals.rows };
}

/** Заявка на вывод: любая сумма в пределах доступного баланса. Блокировка по сотруднику — две заявки разом не превысят баланс. */
export async function requestWithdrawal(db: Db, userId: number, amount: number) {
  const value = Math.round(amount * 100) / 100;
  if (!Number.isFinite(value) || value <= 0) throw new HttpError(400, 'bad_amount', 'Введите сумму больше нуля');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [userId]);
    const { rows } = await client.query<{ available: string }>(
      `SELECT (SELECT COALESCE(sum(amount), 0) FROM okc_bonus_accruals WHERE user_id = $1)
            - (SELECT COALESCE(sum(amount), 0) FROM okc_withdrawals WHERE user_id = $1 AND status IN ('pending', 'approved')) AS available`,
      [userId],
    );
    const available = Number(rows[0].available);
    if (value > available + 1e-9) throw new HttpError(400, 'too_much', `Доступно к выводу ${available.toLocaleString('ru-RU')} ₽`);
    const w = await client.query<{ id: number }>('INSERT INTO okc_withdrawals (user_id, amount) VALUES ($1, $2) RETURNING id', [userId, value]);
    await client.query('COMMIT');
    return { id: w.rows[0].id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function decideWithdrawal(db: Db, adminId: number, id: number, approve: boolean, comment: string) {
  if (!approve && !comment.trim()) throw new HttpError(400, 'need_comment', 'Напишите причину отклонения — её увидит оператор');
  const { rowCount } = await db.query(
    `UPDATE okc_withdrawals SET status = $2, comment = $3, decided_by = $4, decided_at = now() WHERE id = $1 AND status = 'pending'`,
    [id, approve ? 'approved' : 'rejected', comment.trim() || null, adminId],
  );
  if (!rowCount) throw new HttpError(409, 'decided', 'Заявка уже рассмотрена');
}
