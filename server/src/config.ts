function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Не задана переменная окружения ${name}`);
  return value;
}

export interface Config {
  port: number;
  publicUrl: string;
  databaseUrl: string;
  sessionSecret: string;
  /** Ключ шифрования телефонов в базе: 32 байта в base64 */
  phoneKey: Buffer;
  /** Первый администратор: создаётся, только если в базе нет ни одного пользователя */
  initialAdminLogin: string;
  initialAdminPassword: string;
  /** Входящий вебхук Битрикс24: https://портал.bitrix24.ru/rest/1/xxxx/ */
  bitrixWebhookUrl: string;
  /** Токен исходящего вебхука Битрикс24 (application_token), им проверяем события */
  bitrixOutgoingToken: string;
  /** Постоянный ключ Call API и Data API UIS */
  uisAccessToken: string;
  /** Секрет в адресе, на который UIS шлёт уведомления о звонках */
  uisHookKey: string;
  tz: string;
  demo: boolean;
}

const withSlash = (url: string) => (url && !url.endsWith('/') ? `${url}/` : url);

export function parsePhoneKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('PHONE_KEY должен быть 32 байта в base64 (openssl rand -base64 32)');
  return key;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 3000),
    publicUrl: (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    databaseUrl: required('DATABASE_URL'),
    sessionSecret: required('SESSION_SECRET'),
    phoneKey: parsePhoneKey(required('PHONE_KEY')),
    initialAdminLogin: process.env.INITIAL_ADMIN_LOGIN ?? 'admin',
    initialAdminPassword: process.env.INITIAL_ADMIN_PASSWORD ?? '',
    bitrixWebhookUrl: withSlash(process.env.BITRIX_WEBHOOK_URL ?? ''),
    bitrixOutgoingToken: process.env.BITRIX_OUTGOING_TOKEN ?? '',
    uisAccessToken: process.env.UIS_ACCESS_TOKEN ?? '',
    uisHookKey: process.env.UIS_HOOK_KEY ?? '',
    tz: process.env.TZ ?? 'Europe/Moscow',
    demo: process.env.DEMO === '1',
  };
}
