import type { Db } from '../db/pool.js';
import { getSetting, type LeadSettings } from '../db/settings.js';
import { decryptPhone } from '../auth/phone.js';
import type { BitrixClient } from './client.js';
import { dealUrl } from './deals.js';

export interface LeadInput {
  referralName: string;
  referralPhone: string;
  comment: string;
  clientName: string;
  dealId: number;
  dealAssignedById: number | null;
  duplicates: { leads: number[]; contacts: number[] };
}

/** Поля нового лида по рекомендации. Отдельная чистая функция — чтобы её можно было проверить тестом. */
export function buildLeadFields(s: LeadSettings, input: LeadInput, portal: string): Record<string, unknown> {
  const title = s.titleTemplate
    .replaceAll('{клиент}', input.clientName)
    .replaceAll('{рекомендуемый}', input.referralName)
    .replaceAll('{сделка}', String(input.dealId));
  const comments = [
    `Рекомендация от клиента ${input.clientName}, сделка #${input.dealId}: ${dealUrl(portal, input.dealId)}`,
    input.comment ? `Комментарий: ${input.comment}` : '',
    input.duplicates.leads.length || input.duplicates.contacts.length
      ? `Номер уже есть в CRM: ${[
          ...input.duplicates.leads.map((id) => `лид #${id}`),
          ...input.duplicates.contacts.map((id) => `контакт #${id}`),
        ].join(', ')}`
      : '',
  ].filter(Boolean).join('\n');
  const fields: Record<string, unknown> = {
    TITLE: title,
    NAME: input.referralName,
    PHONE: [{ VALUE: `+${input.referralPhone}`, VALUE_TYPE: 'MOBILE' }],
    SOURCE_ID: s.sourceId || 'RECOMMENDATION',
    SOURCE_DESCRIPTION: `Рекомендация: ${input.clientName}`,
    COMMENTS: comments,
  };
  const assigned = s.assignedById ?? input.dealAssignedById;
  if (assigned) fields.ASSIGNED_BY_ID = assigned;
  if (s.refDealField) fields[s.refDealField] = input.dealId;
  return fields;
}

/** Отправляет рекомендацию в Битрикс24 новым лидом. Ошибку записывает в рекомендацию, чтобы её можно было отправить ещё раз. */
export async function sendReferral(db: Db, bx: BitrixClient, phoneKey: Buffer, referralId: number): Promise<{ ok: boolean; leadId?: number; error?: string }> {
  const { rows } = await db.query<{ name: string; phone_enc: string; comment: string; status: string; bitrix_lead_id: number | null; client_name: string; deal_id: string }>(
    `SELECT r.name, r.phone_enc, r.comment, r.status, r.bitrix_lead_id, c.client_name, c.deal_id
       FROM referrals r JOIN cards c ON c.id = r.card_id WHERE r.id = $1`,
    [referralId],
  );
  const r = rows[0];
  if (!r) return { ok: false, error: 'Рекомендация не найдена' };
  if (r.status === 'sent' && r.bitrix_lead_id) return { ok: true, leadId: r.bitrix_lead_id };
  try {
    const phone = decryptPhone(r.phone_enc, phoneKey);
    const settings = await getSetting(db, 'lead');
    const dealId = Number(r.deal_id);
    const deal = await bx.result<{ ASSIGNED_BY_ID?: string }>('crm.deal.get', { id: dealId });
    const dup = await bx
      .result<{ LEAD?: number[]; CONTACT?: number[] }>('crm.duplicate.findbycomm', { type: 'PHONE', values: [`+${phone}`, phone] })
      .catch(() => ({}) as { LEAD?: number[]; CONTACT?: number[] });
    const fields = buildLeadFields(settings, {
      referralName: r.name,
      referralPhone: phone,
      comment: r.comment,
      clientName: r.client_name,
      dealId,
      dealAssignedById: Number(deal.ASSIGNED_BY_ID) || null,
      duplicates: { leads: dup.LEAD ?? [], contacts: dup.CONTACT ?? [] },
    }, bx.portalUrl);
    const leadId = Number(await bx.result<number>('crm.lead.add', { fields, params: { REGISTER_SONET_EVENT: 'Y' } }));
    await db.query("UPDATE referrals SET status = 'sent', bitrix_lead_id = $2, error = NULL, sent_at = now() WHERE id = $1", [referralId, leadId]);
    return { ok: true, leadId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db.query("UPDATE referrals SET status = 'error', error = $2 WHERE id = $1", [referralId, error]);
    return { ok: false, error };
  }
}

