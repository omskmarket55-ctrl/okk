export const fmtDateTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

export const fmtDate = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleDateString('ru-RU') : '—');

export const fmtSeconds = (s: number | null | undefined) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

export const npsClass = (n: number | null | undefined) => (n == null ? '' : n >= 9 ? 'good' : n >= 7 ? 'warn' : 'bad');

/** Значение для input[type=datetime-local] в местном времени */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const OUTCOME: Record<string, string> = { done: 'анкета заполнена', callback: 'клиент попросил перезвонить', refused: 'отказ от опроса' };

/** Строка истории карточки */
export function eventText(e: { type: string; data: Record<string, unknown> }): string {
  const d = e.data ?? {};
  switch (e.type) {
    case 'imported': return `Клиент загружен из Битрикс24 по делу #${d.activityId}${d.subject ? ` «${d.subject}»` : ''}${d.noPhone ? '. Телефона в контакте нет' : ''}`;
    case 'duplicate_activity': return `Новое дело #${d.activityId} по той же сделке — клиент уже в обзвоне`;
    case 'opened': return d.repeat ? 'Повторный звонок: карточка открыта' : 'Карточка открыта';
    case 'call_started': return d.repeat ? 'Повторный звонок через UIS' : 'Звонок через UIS';
    case 'call_error': return `Звонок не начался: ${d.error}`;
    case 'callback_scheduled': return `Перезвон назначен на ${fmtDateTime(d.at as string)}${d.note ? ` — ${d.note}` : ''}`;
    case 'callback_due': return `Повторный звонок: карточка вернулась в очередь (перезвон на ${fmtDateTime(d.callbackAt as string)})`;
    case 'response_saved': return `Анкета сохранена: ${OUTCOME[String(d.outcome)] ?? d.outcome}${d.nps != null ? `, NPS ${d.nps}` : ''}`;
    case 'lead_created': return `Создан лид #${d.leadId} в Битрикс24${d.resend ? ' (повторная отправка)' : ''}`;
    case 'lead_error': return `Лид не создан: ${d.error}`;
    case 'sms_sent': return 'Отправлено СМС';
    case 'sms_error': return `СМС не отправлено: ${d.error}`;
    case 'assigned': return d.userId ? 'Назначен сотрудник' : 'Назначение снято';
    case 'requeued': return 'Возвращена в очередь';
    case 'closed': return 'Снята с обзвона';
    case 'activity_completed': return 'Дело в Битрикс24 закрыто';
    default: return e.type;
  }
}
