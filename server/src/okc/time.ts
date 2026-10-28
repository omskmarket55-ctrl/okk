/** Дата ГГГГ-ММ-ДД в часовом поясе компании */
export function dayIn(tz: string, d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Местное время ГГГГ-ММ-ДД ЧЧ:ММ:СС — для календаря Битрикс24 */
export function localDateTime(tz: string, d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * Дело «Напомнить о встрече» — только для офисной встречи завтра или позже, за reminderHours до начала.
 * Если это время уже прошло (встреча рано утром), дело ставится на текущий момент.
 */
export function reminderDue(meetingAt: Date, type: string, reminderHours: number, tz: string, now = new Date()): Date | null {
  if (type !== 'office') return null;
  if (dayIn(tz, meetingAt) <= dayIn(tz, now)) return null;
  const due = new Date(meetingAt.getTime() - reminderHours * 3_600_000);
  return due < now ? now : due;
}
