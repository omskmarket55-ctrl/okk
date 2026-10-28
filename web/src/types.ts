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
