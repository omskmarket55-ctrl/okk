import { describe, expect, it } from 'vitest';
import { BitrixClient } from '../src/bitrix/client.js';
import { contactName, contactPhone, formatFieldValue } from '../src/bitrix/deals.js';
import { buildLeadFields } from '../src/bitrix/leads.js';
import { activityFilter, matchesDeal, matchesSubject } from '../src/bitrix/sync.js';
import { DEFAULT_SETTINGS } from '../src/db/settings.js';
import { UisCallApi } from '../src/uis/callApi.js';
import { parseUisNotification } from '../src/routes/hooks.js';
import { parsePeriod } from '../src/routes/reports.js';
import { smsru, fillSmsTemplate } from '../src/sms/providers.js';
import { optionBreakdown, weekStart } from '../src/reports/dashboard.js';
import { STARTER_SURVEY } from '../src/surveys/schema.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Битрикс24', () => {
  it('клиент вебхука: адрес метода и повтор при лимите', async () => {
    const urls: string[] = [];
    let n = 0;
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return n++ === 0 ? json({ error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many' }, 503) : json({ result: { ID: 1 } });
    }) as typeof fetch;
    const bx = new BitrixClient('https://test.bitrix24.ru/rest/1/abc/', fetchFn, 0);
    expect(await bx.result('crm.deal.get', { id: 1 })).toEqual({ ID: 1 });
    expect(urls[0]).toBe('https://test.bitrix24.ru/rest/1/abc/crm.deal.get.json');
    expect(urls).toHaveLength(2);
    expect(bx.portalUrl).toBe('https://test.bitrix24.ru');
  });

  it('фильтр дел по настройкам источника', () => {
    const s = { ...DEFAULT_SETTINGS.source, responsibleIds: [12], providerId: 'CRM_TODO', sinceDate: '2026-10-01' };
    expect(activityFilter(s, 500)).toEqual({
      OWNER_TYPE_ID: 2, COMPLETED: 'N', '>ID': 500, PROVIDER_ID: 'CRM_TODO', RESPONSIBLE_ID: [12], '>=CREATED': '2026-10-01T00:00:00',
    });
    expect(matchesSubject({ ...s, subjectContains: 'ОКК' }, { ID: '1', OWNER_ID: '1', OWNER_TYPE_ID: '2', SUBJECT: 'Опрос окк после встречи' })).toBe(true);
    expect(matchesSubject({ ...s, subjectContains: 'ОКК' }, { ID: '1', OWNER_ID: '1', OWNER_TYPE_ID: '2', SUBJECT: 'Звонок' })).toBe(false);
    expect(matchesDeal({ ...s, categoryId: 3, stageIds: [] }, { CATEGORY_ID: '3' })).toBe(true);
    expect(matchesDeal({ ...s, categoryId: 3, stageIds: [] }, { CATEGORY_ID: '0' })).toBe(false);
    expect(matchesDeal({ ...s, categoryId: null, stageIds: ['C3:WON'] }, { STAGE_ID: 'C3:NEW' })).toBe(false);
  });

  it('контакт и поля сделки', () => {
    expect(contactName({ NAME: 'Елена', LAST_NAME: 'Смирнова', SECOND_NAME: 'Викторовна' })).toBe('Смирнова Елена Викторовна');
    expect(contactPhone({ PHONE: [{ VALUE: '+7 495', VALUE_TYPE: 'WORK' }, { VALUE: '+7 913', VALUE_TYPE: 'MOBILE' }] })).toBe('+7 913');
    const ctx = { users: new Map([['7', 'Петров Алексей']]), stages: new Map([['WON', 'Успешно']]) };
    expect(formatFieldValue('7', { type: 'user', title: 'Менеджер' }, ctx)).toBe('Петров Алексей');
    expect(formatFieldValue('2', { type: 'enumeration', title: 'Город', items: [{ ID: '2', VALUE: 'Омск' }] }, ctx)).toBe('Омск');
    expect(formatFieldValue('WON', { type: 'crm_status', title: 'Стадия' }, ctx)).toBe('Успешно');
    expect(formatFieldValue('86400.00', { type: 'double', title: 'Сумма' }, { ...ctx, currency: 'RUB' }).replace(/\s/g, ' ')).toBe('86 400 ₽');
    expect(formatFieldValue(null, undefined, ctx)).toBe('—');
  });

  it('лид по рекомендации', () => {
    const f = buildLeadFields(
      { ...DEFAULT_SETTINGS.lead, refDealField: 'UF_CRM_REF' },
      { referralName: 'Игорь', referralPhone: '79131234567', comment: 'Окна', clientName: 'Смирнова Елена', dealId: 48213, dealAssignedById: 9, duplicates: { leads: [5], contacts: [] } },
      'https://test.bitrix24.ru',
    );
    expect(f).toMatchObject({
      TITLE: 'Рекомендация от Смирнова Елена', NAME: 'Игорь', SOURCE_ID: 'RECOMMENDATION', ASSIGNED_BY_ID: 9, UF_CRM_REF: 48213,
      PHONE: [{ VALUE: '+79131234567', VALUE_TYPE: 'MOBILE' }],
    });
    expect(f.COMMENTS).toContain('https://test.bitrix24.ru/crm/deal/details/48213/');
    expect(f.COMMENTS).toContain('лид #5');
  });
});

describe('UIS', () => {
  it('звонок: сначала сотрудник, виртуальный номер вместо номера клиента', async () => {
    let sent: { method: string; params: Record<string, unknown> } | null = null;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return json({ jsonrpc: '2.0', id: 1, result: { data: { call_session_id: 777 } } });
    }) as typeof fetch;
    const uis = new UisCallApi('KEY', fetchFn);
    expect(await uis.startEmployeeCall({ employeeId: 5, contact: '79131234567', virtualNumber: '74951234567', externalId: 'okk-1' })).toBe(777);
    expect(sent!.method).toBe('start.employee_call');
    expect(sent!.params).toMatchObject({ access_token: 'KEY', first_call: 'employee', show_virtual_phone_number: true, employee: { id: 5 } });
  });

  it('ошибки UIS переводятся на понятный язык', async () => {
    const fetchFn = (async () => json({ jsonrpc: '2.0', id: 1, error: { code: -32003, message: 'Your IP is not whitelisted', data: { mnemonic: 'ip_not_whitelisted' } } })) as typeof fetch;
    await expect(new UisCallApi('KEY', fetchFn).startEmployeeCall({ employeeId: 1, contact: '7', virtualNumber: '7', externalId: 'x' })).rejects.toThrow(/белый список/);
  });

  it('уведомление о звонке', () => {
    expect(parseUisNotification({ call_session_id: '12', event: 'call_end', talk_time_duration: '95', call_records: 'a1,b2' }))
      .toEqual({ session: 12, status: 'ended', talk: 95, records: ['a1', 'b2'] });
    expect(parseUisNotification({ call_session_id: 12, notification_name: 'Пропущенный' }).status).toBe('missed');
    expect(parseUisNotification({}).session).toBeNull();
  });
});

describe('СМС и отчёты', () => {
  it('SMS.ru: успешная отправка', async () => {
    const fetchFn = (async (url: string) => {
      expect(url).toContain('to=79131234567');
      return json({ status: 'OK', sms: { '79131234567': { status: 'OK', sms_id: '000-1' } } });
    }) as typeof fetch;
    expect(await smsru.send({ to: '79131234567', text: 'Привет', sender: '', credentials: { apiId: 'k' } }, fetchFn)).toEqual({ ok: true, messageId: '000-1' });
  });

  it('шаблон СМС', () => {
    expect(fillSmsTemplate('{имя}, спасибо!', { fullName: 'Смирнова Елена Викторовна' })).toBe('Елена, спасибо!');
  });

  it('период по умолчанию — 30 дней, конец включительно', () => {
    const p = parsePeriod({}, new Date(2026, 9, 28, 15));
    expect(p.to.getTime() - p.from.getTime()).toBe(30 * 86_400_000);
    expect(() => parsePeriod({ from: '2026-10-10', to: '2026-10-01' })).toThrow();
  });

  it('неделя начинается с понедельника', () => {
    expect(weekStart(new Date('2026-10-28T12:00:00Z'))).toBe('2026-10-26');
    expect(weekStart(new Date('2026-10-26T00:00:00Z'))).toBe('2026-10-26');
  });

  it('разбивка ответов по группам NPS', () => {
    const rows = [
      { nps: 3, answers: { nps: 3, bad: ['b1'], partner: 'no' }, schema: STARTER_SURVEY },
      { nps: 10, answers: { nps: 10, good: ['g1'], partner: 'yes' }, schema: STARTER_SURVEY },
    ];
    const b = optionBreakdown(rows);
    const partner = b.find((q) => q.title === 'Партнёрская программа')!;
    expect(partner.options.find((o) => o.label === 'Отказ')).toMatchObject({ total: 1, detractor: 1 });
    expect(b.find((q) => q.title === 'Что стоило сделать лучше')!.options[0]).toMatchObject({ label: 'Сроки', detractor: 1 });
  });
});
