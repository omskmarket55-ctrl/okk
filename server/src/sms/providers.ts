import type { SmsProviderId } from '../db/settings.js';

export interface SmsResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface SmsProvider {
  id: SmsProviderId;
  name: string;
  /** Поля ключей для формы настроек */
  credentialFields: { key: string; label: string; secret?: boolean }[];
  send(p: { to: string; text: string; sender: string; credentials: Record<string, string> }, fetchFn?: typeof fetch): Promise<SmsResult>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** SMS.ru: https://sms.ru/api/send */
export const smsru: SmsProvider = {
  id: 'smsru',
  name: 'SMS.ru',
  credentialFields: [{ key: 'apiId', label: 'api_id', secret: true }],
  async send({ to, text, sender, credentials }, fetchFn = fetch) {
    try {
      const q = new URLSearchParams({ api_id: credentials.apiId ?? '', to, msg: text, json: '1' });
      if (sender) q.set('from', sender);
      const res = await fetchFn(`https://sms.ru/sms/send?${q}`);
      const body = (await res.json()) as { status: string; status_text?: string; sms?: Record<string, { status: string; sms_id?: string; status_text?: string }> };
      const item = body.sms?.[to];
      if (body.status === 'OK' && item?.status === 'OK') return { ok: true, messageId: item.sms_id };
      return { ok: false, error: item?.status_text ?? body.status_text ?? 'SMS.ru не принял сообщение' };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  },
};

/** SMSC.ru: https://smsc.ru/api/http/send/ */
export const smsc: SmsProvider = {
  id: 'smsc',
  name: 'SMSC.ru',
  credentialFields: [{ key: 'login', label: 'Логин' }, { key: 'password', label: 'Пароль или API-ключ', secret: true }],
  async send({ to, text, sender, credentials }, fetchFn = fetch) {
    try {
      const q = new URLSearchParams({ login: credentials.login ?? '', psw: credentials.password ?? '', phones: to, mes: text, fmt: '3', charset: 'utf-8' });
      if (sender) q.set('sender', sender);
      const res = await fetchFn(`https://smsc.ru/sys/send.php?${q}`);
      const body = (await res.json()) as { id?: number; error?: string; error_code?: number };
      if (body.id && !body.error) return { ok: true, messageId: String(body.id) };
      return { ok: false, error: body.error ?? 'SMSC.ru не принял сообщение' };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  },
};

/** SMS Aero: https://smsaero.ru/integration/api/ (v2) */
export const smsaero: SmsProvider = {
  id: 'smsaero',
  name: 'SMS Aero',
  credentialFields: [{ key: 'email', label: 'E-mail аккаунта' }, { key: 'apiKey', label: 'API-ключ', secret: true }],
  async send({ to, text, sender, credentials }, fetchFn = fetch) {
    try {
      const q = new URLSearchParams({ number: to, text, sign: sender || 'SMS Aero' });
      const auth = Buffer.from(`${credentials.email ?? ''}:${credentials.apiKey ?? ''}`).toString('base64');
      const res = await fetchFn(`https://gate.smsaero.ru/v2/sms/send?${q}`, { headers: { Authorization: `Basic ${auth}` } });
      const body = (await res.json()) as { success: boolean; message?: string; data?: { id?: number } };
      if (body.success && body.data?.id) return { ok: true, messageId: String(body.data.id) };
      return { ok: false, error: body.message ?? 'SMS Aero не принял сообщение' };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  },
};

/** «Трубка» (b24-sms-gateway): подключим, когда приложение пройдёт модерацию Битрикс24. */
export const truba: SmsProvider = {
  id: 'truba',
  name: 'Трубка',
  credentialFields: [{ key: 'url', label: 'Адрес API' }, { key: 'token', label: 'Ключ', secret: true }],
  async send() {
    return { ok: false, error: 'Отправка через «Трубку» появится после модерации приложения в Битрикс24' };
  },
};

export const SMS_PROVIDERS: Record<SmsProviderId, SmsProvider> = { smsru, smsc, smsaero, truba };

/** Подстановка данных клиента в шаблон СМС. */
export function fillSmsTemplate(text: string, client: { fullName: string }): string {
  const [last = '', first = '', middle = ''] = client.fullName.split(/\s+/);
  return text
    .replaceAll('{имя}', first || last)
    .replaceAll('{имя отчество}', [first || last, middle].filter(Boolean).join(' '))
    .replaceAll('{фио}', client.fullName);
}
