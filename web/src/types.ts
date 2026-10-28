import type { Answers, SurveySchema } from '../../server/src/surveys/schema';

export interface QueueItem {
  id: number;
  clientName: string;
  phoneTail: string | null;
  dealTitle: string | null;
  repeat: boolean;
  attempts: number;
  callbackAt: string | null;
  createdAt: string;
  lockedByMe: boolean;
}

export interface CardEvent { id: number; type: string; data: Record<string, unknown>; createdAt: string; userName: string | null }

export interface CardView {
  id: number;
  dealId: number;
  dealUrl: string | null;
  clientName: string;
  phone: string;
  phoneFull: boolean;
  hasPhone: boolean;
  dealTitle: string | null;
  fields: { code: string; label: string; value: string }[];
  status: string;
  statusLabel: string;
  repeat: boolean;
  attempts: number;
  callbackAt: string | null;
  assignedUserId: number | null;
  assignedName: string | null;
  createdAt: string;
  survey: { versionId: number; surveyId: number; name: string; schema: SurveySchema } | null;
  draftAnswers: Answers | null;
  responses: { id: number; answers: Record<string, unknown>; nps: number | null; outcome: string; createdAt: string; updatedAt: string; userName: string | null; schema: SurveySchema; version: number; surveyName: string }[];
  referrals: { id: number; name: string; comment: string; status: string; error: string | null; phone: string; leadId: number | null; leadUrl: string | null; createdAt: string }[];
  calls: { id: number; status: string; repeat: boolean; error: string | null; talkSeconds: number | null; startedAt: string; endedAt: string | null; records: number; userName: string | null; canListen: boolean }[];
  sms: { id: number; provider: string; text: string; status: string; error: string | null; createdAt: string; userName: string | null }[];
  events: CardEvent[];
}

export const CALL_STATUS: Record<string, string> = {
  starting: 'Соединяем…', ringing: 'Звоним вам на софтфон, затем клиенту…', talk: 'Разговор', ended: 'Звонок завершён', missed: 'Не дозвонились', error: 'Ошибка звонка',
};

export interface OkcCard {
  id: number;
  phone: string;
  clientName: string | null;
  status: string;
  statusLabel: string;
  ownerId: number | null;
  ownerName: string | null;
  pinUntil: string | null;
  availableAt: string;
  callbackAt: string | null;
  isCurrent: boolean;
  canAct: boolean;
  attempts: number;
  refuseReason: string | null;
  meeting: { at: string; type: string; typeLabel: string; region: string; regionLabel: string; byName: string | null } | null;
  dealId: number | null;
  dealUrl: string | null;
  bitrixError: string | null;
  batchName: string | null;
  createdAt: string;
  events: CardEvent[];
  calls: { id: number; status: string; error: string | null; talkSeconds: number | null; startedAt: string; records: number; userName: string | null; canListen: boolean }[];
  tasks: { id: number; type: string; dueAt: string; doneAt: string | null; userName: string | null }[];
}

export const OKC_EVENT_TEXT: Record<string, (d: Record<string, unknown>) => string> = {
  comment: (d) => String(d.text ?? ''),
  call: () => 'Звонок через UIS',
  later: () => 'Позвонить позднее',
  agreement: (d) => `Есть договорённость: звонок ${new Date(String(d.at)).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`,
  refused: (d) => `Отказ: ${d.reason}`,
  returned: () => 'Возвращена в работу',
  released: (d) => (d.reason === 'auto' ? 'Откреплена автоматически и вернулась в общую базу' : 'Снята с оператора и вернулась в общую базу'),
  meeting_set: (d) => `Назначена встреча: ${d.type === 'office' ? 'офисная' : 'ДКС'}, ${new Date(String(d.at)).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`,
  deal_created: (d) => `Создана сделка #${d.dealId} в Битрикс24`,
  deal_error: (d) => `Сделка в Битрикс24 не создана: ${d.error}`,
  meeting_done: (d) => `Встреча состоялась${d.bonus ? `, начислен бонус ${Number(d.bonus).toLocaleString('ru-RU')} ₽` : ''}`,
  meeting_failed: () => 'Встреча не состоялась — карточка снова в обзвоне',
  task_done: () => 'Дело «Напомнить о встрече» выполнено',
  task_moved: (d) => `Дело перенесено на ${new Date(String(d.dueAt)).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`,
};
