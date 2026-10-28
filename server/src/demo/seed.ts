import type { Db } from '../db/pool.js';
import { encryptPhone, last2 } from '../auth/phone.js';
import { hashPassword } from '../auth/password.js';
import { STARTER_SURVEY } from '../surveys/schema.js';
import { importBase } from '../okc/base.js';

/**
 * Демо-данные (DEMO=1): анкета, оператор и примерные клиенты, чтобы посмотреть кабинет до подключения Битрикс24.
 * Срабатывает только на пустой базе карточек. Сделки помечены ID от 900000 — в настоящем портале таких нет.
 */
export async function seedDemo(db: Db, phoneKey: Buffer): Promise<boolean> {
  await seedOkcDemo(db, phoneKey);
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM cards');
  if (Number(rows[0].n) > 0) return false;

  const survey = await db.query<{ id: number }>("INSERT INTO surveys (name, draft) VALUES ('NPS после встречи (демо)', $1) RETURNING id", [STARTER_SURVEY]);
  const version = await db.query<{ id: number }>('INSERT INTO survey_versions (survey_id, version, schema) VALUES ($1, 1, $2) RETURNING id', [survey.rows[0].id, STARTER_SURVEY]);
  await db.query('UPDATE surveys SET active_version_id = $2 WHERE id = $1', [survey.rows[0].id, version.rows[0].id]);

  const role = await db.query<{ id: number }>("SELECT id FROM roles WHERE name = 'Оператор'");
  const op = await db.query<{ id: number }>(
    "INSERT INTO users (login, name, password_hash, role_id) VALUES ('operator', 'Анна Котова (демо)', $1, $2) ON CONFLICT (login) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    [await hashPassword('operator-demo'), role.rows[0].id],
  );

  const clients: [string, string, string, string][] = [
    ['Смирнова Елена Викторовна', '79131112247', 'Остекление балкона', '86 400 ₽'],
    ['Гусев Павел Андреевич', '79139990009', 'Пластиковые окна, 3 шт.', '124 900 ₽'],
    ['Ахметова Динара Руслановна', '79045553381', 'Входная дверь', '42 300 ₽'],
    ['Ковалёв Игорь Сергеевич', '79620001130', 'Отделка лоджии', '158 000 ₽'],
    ['Белова Ольга Николаевна', '79083334462', 'Москитные сетки', '9 800 ₽'],
    ['Тарасов Михаил Олегович', '79507776615', 'Пластиковые окна', '67 200 ₽'],
  ];
  const ids: number[] = [];
  for (const [i, [name, phone, title, sum]] of clients.entries()) {
    const fields = [{ code: 'OPPORTUNITY', label: 'Сумма', value: sum }, { code: 'ASSIGNED_BY_ID', label: 'Менеджер', value: i % 2 ? 'Ершова Татьяна' : 'Петров Алексей' }];
    const c = await db.query<{ id: number }>(
      `INSERT INTO cards (deal_id, activity_id, client_name, phone_enc, phone_last2, deal_title, deal_fields, survey_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - make_interval(days => $9)) RETURNING id`,
      [900001 + i, 990001 + i, name, encryptPhone(phone, phoneKey), last2(phone), title, JSON.stringify(fields), survey.rows[0].id, i],
    );
    ids.push(c.rows[0].id);
    await db.query("INSERT INTO card_events (card_id, type, data) VALUES ($1, 'imported', $2)", [c.rows[0].id, { activityId: 990001 + i, subject: 'Опрос ОКК после встречи' }]);
  }

  // Две карточки уже обработаны: для дашборда и карточки клиента у администратора
  const done: [number, number, Record<string, unknown>][] = [
    [ids[4], 10, { nps: 10, good: ['g1', 'g2'], comment: 'Мастера приехали вовремя, всё убрали', partner: 'no' }],
    [ids[5], 5, { nps: 5, bad: ['b1'], comment: 'Перенесли монтаж на неделю без звонка', partner: 'no' }],
  ];
  for (const [cardId, nps, answers] of done) {
    await db.query('INSERT INTO responses (card_id, survey_version_id, user_id, answers, nps, outcome) VALUES ($1, $2, $3, $4, $5, $6)', [cardId, version.rows[0].id, op.rows[0].id, answers, nps, 'done']);
    await db.query("UPDATE cards SET status = 'done', assigned_user_id = $2 WHERE id = $1", [cardId, op.rows[0].id]);
    await db.query("INSERT INTO card_events (card_id, type, user_id, data) VALUES ($1, 'response_saved', $2, $3)", [cardId, op.rows[0].id, { outcome: 'done', nps }]);
  }
  // Одна ждёт перезвона завтра
  await db.query("UPDATE cards SET status = 'callback', callback_at = now() + interval '1 day' WHERE id = $1", [ids[3]]);
  await db.query("INSERT INTO card_events (card_id, type, user_id, data) VALUES ($1, 'callback_scheduled', $2, $3)", [ids[3], op.rows[0].id, { at: new Date(Date.now() + 86_400_000), reason: 'later', note: 'Просил позвонить после работы' }]);
  return true;
}

/** Демо ОКЦ: оператор okc / okc-operator-demo и база из 12 номеров 7900000xxxx (таких абонентов нет). */
async function seedOkcDemo(db: Db, phoneKey: Buffer) {
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM okc_cards');
  if (Number(rows[0].n) > 0) return;
  const role = await db.query<{ id: number }>("SELECT id FROM roles WHERE name = 'Оператор ОКЦ'");
  const op = await db.query<{ id: number }>(
    "INSERT INTO users (login, name, password_hash, role_id) VALUES ('okc', 'Ольга Смирнова (демо ОКЦ)', $1, $2) ON CONFLICT (login) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    [await hashPassword('okc-operator-demo'), role.rows[0].id],
  );
  const phones = Array.from({ length: 12 }, (_, i) => `7900000${String(1001 + i)}`).join('\n');
  await importBase(db, op.rows[0].id, 'Демо-база', phones, phoneKey);
}
