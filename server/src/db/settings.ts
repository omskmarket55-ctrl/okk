import type { Db } from './pool.js';

/** Какие дела в Битрикс24 приводят клиента в кабинет. */
export interface SourceSettings {
  enabled: boolean;
  /** Тип дела: PROVIDER_ID (например CRM_TODO) и при необходимости PROVIDER_TYPE_ID */
  providerId: string;
  providerTypeId: string;
  /** Тема дела содержит этот текст (пусто — любая) */
  subjectContains: string;
  /** Ответственные за дело: сотрудники контроля качества (ID пользователей Битрикс24) */
  responsibleIds: number[];
  /** Воронка сделки (пусто — любая) и стадии (пусто — любые) */
  categoryId: number | null;
  stageIds: string[];
  /** Брать дела, созданные не раньше этой даты (ГГГГ-ММ-ДД) */
  sinceDate: string;
  /** Анкета для новых карточек */
  surveyId: number | null;
  /** Закрывать дело в Битрикс24, когда анкета заполнена или клиент отказался */
  completeActivity: boolean;
}

/** Поля сделки на карточке сотрудника: коды полей Битрикс24 и подписи */
export interface CardFieldsSettings {
  fields: { code: string; label: string }[];
}

export interface LeadSettings {
  /** Источник лида (SOURCE_ID): RECOMMENDATION — «По рекомендации» */
  sourceId: string;
  /** Ответственный за лид (ID пользователя Битрикс24); пусто — ответственный за сделку клиента */
  assignedById: number | null;
  /** Название лида. Подстановки: {клиент}, {рекомендуемый}, {сделка} */
  titleTemplate: string;
  /** Пользовательское поле лида для ID сделки рекомендателя, например UF_CRM_REF_DEAL (необязательно) */
  refDealField: string;
}

export interface QueueSettings {
  /** За сколько минут до назначенного времени перезвона карточка возвращается в очередь */
  callbackLeadMinutes: number;
}

export interface UisSettings {
  /** Виртуальный номер UIS, с которого идёт обзвон, в формате 7XXXXXXXXXX */
  virtualNumber: string;
}

export type SmsProviderId = 'smsru' | 'smsc' | 'smsaero' | 'truba';

export interface SmsSettings {
  /** Сервис по умолчанию */
  defaultProvider: SmsProviderId | null;
  /** Подключённые сервисы и их ключи. Ключи в браузер не отдаются. */
  providers: Partial<Record<SmsProviderId, { enabled: boolean; sender: string; credentials: Record<string, string> }>>;
  templates: { id: string; name: string; text: string }[];
  /** Можно ли сотруднику править текст шаблона перед отправкой */
  allowEdit: boolean;
}

export interface SettingsMap {
  source: SourceSettings;
  cardFields: CardFieldsSettings;
  lead: LeadSettings;
  queue: QueueSettings;
  uis: UisSettings;
  sms: SmsSettings;
  /** Служебное: последнее обработанное дело и время синхронизации */
  syncState: { lastActivityId: number; lastRunAt: string | null; lastError: string | null; imported: number };
}

export const DEFAULT_SETTINGS: SettingsMap = {
  source: {
    enabled: false,
    providerId: 'CRM_TODO',
    providerTypeId: '',
    subjectContains: '',
    responsibleIds: [],
    categoryId: null,
    stageIds: [],
    sinceDate: new Date().toISOString().slice(0, 10),
    surveyId: null,
    completeActivity: false,
  },
  cardFields: { fields: [{ code: 'OPPORTUNITY', label: 'Сумма' }, { code: 'ASSIGNED_BY_ID', label: 'Менеджер' }] },
  lead: { sourceId: 'RECOMMENDATION', assignedById: null, titleTemplate: 'Рекомендация от {клиент}', refDealField: '' },
  queue: { callbackLeadMinutes: 15 },
  uis: { virtualNumber: '' },
  sms: { defaultProvider: null, providers: {}, templates: [], allowEdit: true },
  syncState: { lastActivityId: 0, lastRunAt: null, lastError: null, imported: 0 },
};

export async function getSetting<K extends keyof SettingsMap>(db: Db, key: K): Promise<SettingsMap[K]> {
  const { rows } = await db.query<{ value: SettingsMap[K] }>('SELECT value FROM settings WHERE key = $1', [key]);
  const def = DEFAULT_SETTINGS[key];
  return rows[0] ? { ...def, ...rows[0].value } : structuredClone(def);
}

export async function setSetting<K extends keyof SettingsMap>(db: Db, key: K, value: SettingsMap[K]): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
