/** Каталог прав. Порядок и группы — как в разделе «Роли и права» админки. */
export const PERMISSION_GROUPS = [
  {
    title: 'Записи звонков',
    items: [
      ['recordings.own', 'Слушать свои звонки'],
      ['recordings.all', 'Слушать звонки всех сотрудников'],
    ],
  },
  {
    title: 'Номера телефонов',
    items: [
      ['phones.view', 'Видеть полный номер клиента'],
      ['referrals.phones.view', 'Видеть полный номер в рекомендациях'],
    ],
  },
  {
    title: 'Клиенты и анкеты',
    items: [
      ['responses.own', 'Видеть свои анкеты'],
      ['responses.all', 'Видеть все анкеты и карточки клиентов'],
      ['responses.edit', 'Редактировать ответы после сохранения'],
      ['responses.delete', 'Удалять анкеты'],
    ],
  },
  {
    title: 'Очередь',
    items: [
      ['queue.work', 'Работать с очередью: звонить и заполнять анкеты'],
      ['queue.assign', 'Назначать карточки сотрудникам'],
      ['queue.manage', 'Переносить перезвоны, возвращать и снимать клиентов с обзвона'],
    ],
  },
  {
    title: 'Битрикс24',
    items: [
      ['bitrix.deal_link', 'Видеть ссылку на сделку'],
      ['leads.create', 'Создавать лид по рекомендации'],
      ['leads.resend', 'Повторно отправлять лид при ошибке'],
    ],
  },
  {
    title: 'СМС',
    items: [['sms.send', 'Отправлять СМС из карточки клиента']],
  },
  {
    title: 'Конструктор анкет',
    items: [
      ['surveys.view', 'Смотреть анкеты'],
      ['surveys.edit', 'Редактировать вопросы и скрипт'],
      ['surveys.publish', 'Публиковать новую версию анкеты'],
    ],
  },
  {
    title: 'Отчёты',
    items: [
      ['reports.own', 'Видеть свою статистику'],
      ['reports.all', 'Видеть дашборд по всем сотрудникам'],
      ['reports.export', 'Выгружать данные в Excel'],
    ],
  },
  {
    title: 'ОКЦ — обзвон базы',
    items: [
      ['okc.work', 'Работать на обзвоне ОКЦ: статусы, карточки, встречи, свой бонус'],
      ['okc.base', 'Загружать базу номеров и смотреть все карточки ОКЦ'],
      ['okc.return', 'Возвращать в работу карточки с отказом'],
      ['okc.reassign', 'Снимать карточки с оператора и отправлять в общую базу'],
      ['okc.stats.all', 'Статистика ОКЦ по всем операторам'],
      ['okc.payouts', 'Стоимость встреч и заявки на вывод бонуса'],
    ],
  },
  {
    title: 'Администрирование',
    items: [
      ['users.manage', 'Управлять сотрудниками'],
      ['roles.manage', 'Управлять ролями и правами'],
      ['integrations.manage', 'Настройки: источник сделок, Битрикс24, UIS, СМС'],
      ['audit.view', 'Журнал действий'],
    ],
  },
] as const;

export type Permission = (typeof PERMISSION_GROUPS)[number]['items'][number][0];

export const ALL_PERMISSIONS: Permission[] = PERMISSION_GROUPS.flatMap((g) => g.items.map(([p]) => p));

export const isPermission = (p: string): p is Permission => (ALL_PERMISSIONS as string[]).includes(p);

/** Готовые роли, создаются при первом запуске. Их права потом можно менять в админке. */
export const DEFAULT_ROLES: { name: string; permissions: Permission[] }[] = [
  { name: 'Администратор', permissions: ALL_PERMISSIONS },
  {
    name: 'Старший смены',
    permissions: [
      'queue.work', 'queue.assign', 'queue.manage', 'responses.own', 'responses.all', 'recordings.own', 'recordings.all',
      'reports.own', 'reports.all', 'leads.create', 'leads.resend', 'bitrix.deal_link', 'sms.send', 'surveys.view',
    ],
  },
  { name: 'Оператор', permissions: ['queue.work', 'responses.own', 'reports.own', 'leads.create', 'sms.send'] },
  { name: 'Оператор ОКЦ', permissions: ['okc.work'] },
  { name: 'Супервайзер ОКЦ', permissions: ['okc.work', 'okc.base', 'okc.return', 'okc.reassign', 'okc.stats.all', 'recordings.all'] },
];

/** Права сотрудника: права роли плюс добавленные минус убранные. */
export function effectivePermissions(role: string[], grant: string[], revoke: string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const p of [...role, ...grant]) if (isPermission(p)) out.add(p);
  for (const p of revoke) out.delete(p as Permission);
  return out;
}
