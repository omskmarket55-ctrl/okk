-- ОКЦ: исходящий обзвон по загруженной базе номеров с записью на встречу.

-- Когда сотрудник последний раз был в кабинете: по этому времени открепляются его карточки
ALTER TABLE users ADD COLUMN last_seen_at timestamptz;

-- Статус оператора ОКЦ: ready — получает карточки, break — перерыв, offline — рабочий день завершён
CREATE TABLE okc_operator_state (
  user_id int PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'offline',
  since timestamptz NOT NULL DEFAULT now()
);

-- Журнал смены статусов: из него считается время перерывов и работы
CREATE TABLE okc_status_log (
  id bigserial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX okc_status_log_user_idx ON okc_status_log (user_id, started_at);

CREATE TABLE okc_batches (
  id serial PRIMARY KEY,
  name text NOT NULL,
  uploaded_by int REFERENCES users(id),
  total int NOT NULL DEFAULT 0,
  added int NOT NULL DEFAULT 0,
  duplicates int NOT NULL DEFAULT 0,
  invalid int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE okc_refuse_reasons (
  id serial PRIMARY KEY,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0
);
INSERT INTO okc_refuse_reasons (name, sort) VALUES
  ('Не интересно', 1), ('Уже есть похожая услуга', 2), ('Дорого', 3), ('Просил больше не звонить', 4), ('Неверный номер', 5);

-- Карточка обзвона: один номер из базы.
-- status: new — в общей базе или закреплена (owner_id), later — «позвонить позднее», agreement — «есть договорённость»,
-- refused — отказ, meeting — назначена встреча, meeting_done — встреча состоялась, meeting_failed — не состоялась и снова в обзвоне.
CREATE TABLE okc_cards (
  id serial PRIMARY KEY,
  batch_id int REFERENCES okc_batches(id),
  phone_enc text NOT NULL,
  phone_last2 text NOT NULL,
  -- HMAC номера: повторная загрузка того же номера не создаёт дубль
  phone_hash text NOT NULL UNIQUE,
  client_name text,
  status text NOT NULL DEFAULT 'new',
  -- Закреплена за сотрудником до pin_until; pin_kind — почему: later, agreement, meeting_failed
  owner_id int REFERENCES users(id),
  pin_kind text,
  pin_until timestamptz,
  -- Раньше этого времени карточка не выдаётся на обзвон
  available_at timestamptz NOT NULL DEFAULT now(),
  callback_at timestamptz,
  -- Карточка сейчас на экране у сотрудника
  current_user_id int REFERENCES users(id),
  current_since timestamptz,
  attempts int NOT NULL DEFAULT 0,
  last_call_at timestamptz,
  refuse_reason_id int REFERENCES okc_refuse_reasons(id),
  meeting_at timestamptz,
  meeting_type text,
  meeting_region text,
  meeting_by int REFERENCES users(id),
  bitrix_deal_id bigint,
  bitrix_event_id bigint,
  bitrix_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX okc_cards_pick_idx ON okc_cards (status, owner_id, available_at);
CREATE UNIQUE INDEX okc_cards_current_idx ON okc_cards (current_user_id) WHERE current_user_id IS NOT NULL;
CREATE INDEX okc_cards_deal_idx ON okc_cards (bitrix_deal_id) WHERE bitrix_deal_id IS NOT NULL;

-- История карточки: её видят все, кто потом звонит по этому номеру
CREATE TABLE okc_events (
  id bigserial PRIMARY KEY,
  card_id int NOT NULL REFERENCES okc_cards(id) ON DELETE CASCADE,
  type text NOT NULL,
  user_id int REFERENCES users(id),
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX okc_events_card_idx ON okc_events (card_id, created_at);
CREATE INDEX okc_events_type_idx ON okc_events (type, created_at);

-- Дела сотрудника: «Напомнить о встрече»
CREATE TABLE okc_tasks (
  id serial PRIMARY KEY,
  card_id int NOT NULL REFERENCES okc_cards(id) ON DELETE CASCADE,
  user_id int NOT NULL REFERENCES users(id),
  type text NOT NULL,
  due_at timestamptz NOT NULL,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX okc_tasks_user_idx ON okc_tasks (user_id, done_at, due_at);

CREATE TABLE okc_calls (
  id bigserial PRIMARY KEY,
  card_id int NOT NULL REFERENCES okc_cards(id) ON DELETE CASCADE,
  user_id int REFERENCES users(id),
  uis_session_id bigint UNIQUE,
  status text NOT NULL DEFAULT 'starting',
  error text,
  talk_seconds int,
  record_ids text[] NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX okc_calls_started_idx ON okc_calls (started_at);

-- Бонус: начисление за каждую состоявшуюся встречу, сумма фиксируется в момент начисления
CREATE TABLE okc_bonus_accruals (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  card_id int NOT NULL UNIQUE REFERENCES okc_cards(id),
  meeting_type text NOT NULL,
  amount numeric(12, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Заявки на вывод: pending — ждёт решения, approved — одобрена, rejected — отклонена
CREATE TABLE okc_withdrawals (
  id serial PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id),
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'pending',
  comment text,
  decided_by int REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- У уже созданной роли администратора появляются права ОКЦ
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT unnest(permissions || ARRAY[
  'okc.work', 'okc.base', 'okc.return', 'okc.reassign', 'okc.stats.all', 'okc.payouts'
])) WHERE name = 'Администратор';
