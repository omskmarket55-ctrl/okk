import type { BitrixClient } from './client.js';

/** Описание поля сделки из crm.deal.fields */
export interface FieldMeta {
  type: string;
  title: string;
  items?: { ID: string; VALUE: string }[];
  isMultiple?: boolean;
}

export interface CardField {
  code: string;
  label: string;
  value: string;
}

interface Contact {
  NAME?: string;
  SECOND_NAME?: string;
  LAST_NAME?: string;
  PHONE?: { VALUE: string; VALUE_TYPE?: string }[];
}

/** ФИО контакта в порядке «Фамилия Имя Отчество». */
export function contactName(c: Contact): string {
  return [c.LAST_NAME, c.NAME, c.SECOND_NAME].map((s) => (s ?? '').trim()).filter(Boolean).join(' ') || 'Без имени';
}

/** Первый телефон контакта: сначала мобильный. */
export function contactPhone(c: Contact): string | null {
  const list = c.PHONE ?? [];
  return (list.find((p) => p.VALUE_TYPE === 'MOBILE') ?? list[0])?.VALUE ?? null;
}

/** Значение поля сделки в виде текста для карточки: списки — по названиям, деньги — с пробелами. */
export function formatFieldValue(raw: unknown, meta: FieldMeta | undefined, ctx: { users: Map<string, string>; stages: Map<string, string>; currency?: string }): string {
  if (raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && !raw.length)) return '—';
  const one = (v: unknown): string => {
    const s = String(v);
    if (!meta) return s;
    if (meta.type === 'enumeration') return meta.items?.find((i) => i.ID === s)?.VALUE ?? s;
    if (meta.type === 'user') return ctx.users.get(s) ?? `Сотрудник #${s}`;
    if (meta.type === 'crm_status') return ctx.stages.get(s) ?? s;
    if (meta.type === 'boolean' || meta.type === 'char') return s === 'Y' || s === '1' ? 'Да' : s === 'N' || s === '0' ? 'Нет' : s;
    if (meta.type === 'date' || meta.type === 'datetime') {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('ru-RU', meta.type === 'datetime' ? { dateStyle: 'short', timeStyle: 'short' } as Intl.DateTimeFormatOptions : undefined);
    }
    if (meta.type === 'double' || meta.type === 'money') {
      const [num, cur] = s.split('|');
      const n = Number(num);
      if (Number.isNaN(n)) return s;
      return `${n.toLocaleString('ru-RU')} ${cur === 'RUB' || (!cur && ctx.currency === 'RUB') ? '₽' : cur ?? ctx.currency ?? ''}`.trim();
    }
    return s;
  };
  return Array.isArray(raw) ? raw.map(one).join(', ') : one(raw);
}

/** Кеш описаний полей, стадий и имён сотрудников: меняются редко. */
export class DealDirectory {
  private fields: Record<string, FieldMeta> | null = null;
  private stages = new Map<string, string>();
  private users = new Map<string, string>();
  private loadedAt = 0;

  constructor(private bx: BitrixClient) {}

  async dealFields(): Promise<Record<string, FieldMeta>> {
    if (!this.fields || Date.now() - this.loadedAt > 3_600_000) {
      this.fields = await this.bx.result<Record<string, FieldMeta & { formLabel?: string; listLabel?: string }>>('crm.deal.fields');
      for (const f of Object.values(this.fields) as (FieldMeta & { formLabel?: string })[]) if (f.formLabel) f.title = f.formLabel;
      const statuses = await this.bx.listAll<{ STATUS_ID: string; NAME: string }>('crm.status.list', { filter: { '%ENTITY_ID': 'DEAL_STAGE' } });
      this.stages = new Map(statuses.map((s) => [s.STATUS_ID, s.NAME]));
      this.loadedAt = Date.now();
    }
    return this.fields;
  }

  async userNames(ids: string[]): Promise<Map<string, string>> {
    const missing = [...new Set(ids)].filter((id) => id && !this.users.has(id));
    if (missing.length) {
      const users = await this.bx.result<{ ID: string; NAME?: string; LAST_NAME?: string }[]>('user.get', { filter: { ID: missing } });
      for (const u of users) this.users.set(String(u.ID), [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || `#${u.ID}`);
    }
    return this.users;
  }

  /** Поля сделки для карточки в заданном порядке. */
  async cardFields(deal: Record<string, unknown>, wanted: { code: string; label: string }[]): Promise<CardField[]> {
    const meta = await this.dealFields();
    const userIds = wanted
      .filter((w) => meta[w.code]?.type === 'user')
      .flatMap((w) => [deal[w.code]].flat().map(String));
    const users = await this.userNames(userIds);
    return wanted.map((w) => ({
      code: w.code,
      label: w.label || meta[w.code]?.title || w.code,
      value: formatFieldValue(deal[w.code], meta[w.code], { users, stages: this.stages, currency: String(deal.CURRENCY_ID ?? 'RUB') }),
    }));
  }
}

export const dealUrl = (portal: string, id: number | string) => `${portal}/crm/deal/details/${id}/`;
export const leadUrl = (portal: string, id: number | string) => `${portal}/crm/lead/details/${id}/`;
