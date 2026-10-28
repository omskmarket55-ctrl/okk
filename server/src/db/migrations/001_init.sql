-- Роли: набор прав, который назначается сотруднику. Системные роли нельзя удалить.
CREATE TABLE roles (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  permissions text[] NOT NULL DEFAULT '{}',
  system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Сотрудники. Поверх роли можно точечно добавить (grant) или убрать (revoke) права.
CREATE TABLE users (
  id serial PRIMARY KEY,
  login text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role_id int NOT NULL REFERENCES roles(id),
  grant_perms text[] NOT NULL DEFAULT '{}',
  revoke_perms text[] NOT NULL DEFAULT '{}',
  uis_employee_id bigint,
  active boolean NOT NULL DEFAULT true,
  -- Растёт при смене пароля или блокировке: старые сессии перестают действовать
  session_version int NOT NULL DEFAULT 1,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Настройки кабинета: источник сделок, поля карточки, лиды, UIS, СМС
CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Анкеты и их версии. Ответы ссылаются на версию, поэтому правка анкеты не портит старые ответы.
CREATE TABLE surveys (
  id serial PRIMARY KEY,
  name text NOT NULL,
  draft jsonb NOT NULL DEFAULT '{"questions": []}',
  active_version_id int,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE survey_versions (
  id serial PRIMARY KEY,
  survey_id int NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  version int NOT NULL,
  schema jsonb NOT NULL,
  published_by int REFERENCES users(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (survey_id, version)
);

ALTER TABLE surveys ADD CONSTRAINT surveys_active_version_fk FOREIGN KEY (active_version_id) REFERENCES survey_versions(id);

-- Карточка клиента в обзвоне: одна на дело-триггер из Битрикс24.
-- status: queued — в очереди, callback — ждёт перезвона, done — анкета заполнена, refused — отказ, closed — снята с обзвона.
CREATE TABLE cards (
  id serial PRIMARY KEY,
  deal_id bigint NOT NULL,
  activity_id bigint UNIQUE,
  contact_id bigint,
  client_name text NOT NULL,
  phone_enc text,
  phone_last2 text,
  deal_title text,
  deal_fields jsonb NOT NULL DEFAULT '[]',
  survey_id int REFERENCES surveys(id),
  status text NOT NULL DEFAULT 'queued',
  callback_at timestamptz,
  -- true, когда карточка вернулась в очередь после перезвона
  repeat boolean NOT NULL DEFAULT false,
  attempts int NOT NULL DEFAULT 0,
  assigned_user_id int REFERENCES users(id),
  locked_by int REFERENCES users(id),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cards_status_idx ON cards (status, callback_at);
CREATE INDEX cards_deal_idx ON cards (deal_id);

-- История карточки: импорт, открытие, звонки, перезвоны, анкеты, лиды, СМС
CREATE TABLE card_events (
  id bigserial PRIMARY KEY,
  card_id int NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  type text NOT NULL,
  user_id int REFERENCES users(id),
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_events_card_idx ON card_events (card_id, created_at);

-- Заполненные анкеты. Хранятся только здесь, в Битрикс24 не передаются.
CREATE TABLE responses (
  id serial PRIMARY KEY,
  card_id int NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  survey_version_id int NOT NULL REFERENCES survey_versions(id),
  user_id int REFERENCES users(id),
  answers jsonb NOT NULL,
  nps smallint,
  -- done — анкета завершена, callback — клиент попросил перезвонить, refused — отказался
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX responses_created_idx ON responses (created_at);

-- Рекомендации: каждая уходит в Битрикс24 новым лидом
CREATE TABLE referrals (
  id serial PRIMARY KEY,
  response_id int NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  card_id int NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone_enc text NOT NULL,
  phone_last2 text NOT NULL,
  comment text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  bitrix_lead_id bigint,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

-- Звонки через UIS. Записи разговоров остаются в UIS, здесь только их идентификаторы.
CREATE TABLE calls (
  id bigserial PRIMARY KEY,
  card_id int NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id int REFERENCES users(id),
  uis_session_id bigint UNIQUE,
  status text NOT NULL DEFAULT 'starting',
  repeat boolean NOT NULL DEFAULT false,
  error text,
  talk_seconds int,
  record_ids text[] NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX calls_card_idx ON calls (card_id);

CREATE TABLE sms_messages (
  id bigserial PRIMARY KEY,
  card_id int NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id int REFERENCES users(id),
  provider text NOT NULL,
  text text NOT NULL,
  status text NOT NULL,
  provider_message_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Журнал действий: входы, права, просмотр номеров, прослушивание записей, настройки
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  user_id int REFERENCES users(id),
  action text NOT NULL,
  target text,
  data jsonb NOT NULL DEFAULT '{}',
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at);
