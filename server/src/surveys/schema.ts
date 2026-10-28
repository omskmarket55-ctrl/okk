// Схема анкеты и правила её заполнения. Чистый модуль без зависимостей:
// его же импортирует фронтенд, чтобы условия показа и проверки совпадали с серверными.

export type QuestionType = 'nps' | 'single' | 'multi' | 'text' | 'yesno' | 'date' | 'referral' | 'info';

export const QUESTION_TYPES: { type: QuestionType; label: string }[] = [
  { type: 'nps', label: 'Оценка NPS 0–10' },
  { type: 'single', label: 'Один вариант' },
  { type: 'multi', label: 'Несколько вариантов' },
  { type: 'yesno', label: 'Да / нет' },
  { type: 'text', label: 'Текст' },
  { type: 'date', label: 'Дата' },
  { type: 'referral', label: 'Рекомендация → лид в Битрикс24' },
  { type: 'info', label: 'Текст скрипта без ответа' },
];

export interface QuestionOption {
  id: string;
  label: string;
  /** callback — выбор варианта требует даты перезвона, карточка вернётся в очередь */
  action?: 'callback' | 'refuse';
}

export type ConditionOp = 'eq' | 'neq' | 'lte' | 'gte' | 'in' | 'answered';

export interface Condition {
  questionId: string;
  op: ConditionOp;
  value?: number | string | boolean | string[];
}

export interface Question {
  id: string;
  type: QuestionType;
  title: string;
  /** Что говорит оператор. Подстановки: {имя}, {отчество}, {фио} */
  script?: string;
  options?: QuestionOption[];
  required?: boolean;
  /** Показывать вопрос, только если выполнены все условия */
  showIf?: Condition[];
  /** Для referral: сколько контактов можно записать */
  maxItems?: number;
}

export interface SurveySchema {
  /** Вступление: оператор говорит его до первого вопроса */
  intro?: string;
  questions: Question[];
  /** Прощание после последнего вопроса */
  outro?: string;
}

export interface ReferralAnswer {
  name: string;
  phone: string;
  comment?: string;
}

export type Answer = number | string | string[] | boolean | ReferralAnswer[] | null;
export type Answers = Record<string, Answer>;

const isEmpty = (a: Answer | undefined) =>
  a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0);

function holds(c: Condition, answers: Answers): boolean {
  const a = answers[c.questionId];
  if (c.op === 'answered') return !isEmpty(a);
  if (isEmpty(a)) return false;
  switch (c.op) {
    case 'eq':
      return Array.isArray(a) ? (a as unknown[]).includes(c.value) : a === c.value || String(a) === String(c.value);
    case 'neq':
      return Array.isArray(a) ? !(a as unknown[]).includes(c.value) : String(a) !== String(c.value);
    case 'lte':
      return typeof a === 'number' && a <= Number(c.value);
    case 'gte':
      return typeof a === 'number' && a >= Number(c.value);
    case 'in': {
      const list = (Array.isArray(c.value) ? c.value : [c.value]).map(String);
      return Array.isArray(a) ? (a as unknown[]).some((x) => list.includes(String(x))) : list.includes(String(a));
    }
  }
}

/** Видимые вопросы при текущих ответах. Вопрос, зависящий от скрытого, тоже скрыт. */
export function visibleQuestions(schema: SurveySchema, answers: Answers): Question[] {
  const shown = new Set<string>();
  const out: Question[] = [];
  for (const q of schema.questions) {
    const ok = (q.showIf ?? []).every((c) => shown.has(c.questionId) && holds(c, answers));
    if (ok) {
      shown.add(q.id);
      out.push(q);
    }
  }
  return out;
}

/** Вариант с действием, выбранный среди видимых вопросов: callback важнее refuse. */
export function chosenAction(schema: SurveySchema, answers: Answers): 'callback' | 'refuse' | null {
  let result: 'callback' | 'refuse' | null = null;
  for (const q of visibleQuestions(schema, answers)) {
    if (q.type !== 'single' && q.type !== 'multi') continue;
    const a = answers[q.id];
    const ids = Array.isArray(a) ? a.map(String) : a == null ? [] : [String(a)];
    for (const o of q.options ?? []) {
      if (!ids.includes(o.id) || !o.action) continue;
      if (o.action === 'callback') return 'callback';
      result = 'refuse';
    }
  }
  return result;
}

const PHONE_RE = /^(\+?7|8)?[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}$/;

/**
 * Проверка ответов. Возвращает ошибки по id вопроса; пустой объект — всё верно.
 * При перезвоне обязательные вопросы можно оставить пустыми: анкету дозаполнят в следующий раз.
 */
export function validateAnswers(schema: SurveySchema, answers: Answers, opts: { partial?: boolean } = {}): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const q of visibleQuestions(schema, answers)) {
    const a = answers[q.id];
    if (q.type === 'info') continue;
    if (isEmpty(a)) {
      if (q.required && !opts.partial) errors[q.id] = 'Обязательный вопрос';
      continue;
    }
    const optionIds = (q.options ?? []).map((o) => o.id);
    switch (q.type) {
      case 'nps':
        if (typeof a !== 'number' || !Number.isInteger(a) || a < 0 || a > 10) errors[q.id] = 'Оценка — целое число от 0 до 10';
        break;
      case 'single':
        if (typeof a !== 'string' || !optionIds.includes(a)) errors[q.id] = 'Выберите вариант из списка';
        break;
      case 'multi':
        if (!Array.isArray(a) || a.some((x) => typeof x !== 'string' || !optionIds.includes(x))) errors[q.id] = 'Выберите варианты из списка';
        break;
      case 'yesno':
        if (typeof a !== 'boolean') errors[q.id] = 'Ответ — да или нет';
        break;
      case 'text':
        if (typeof a !== 'string' || a.length > 5000) errors[q.id] = 'Текст до 5000 символов';
        break;
      case 'date':
        if (typeof a !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a)) errors[q.id] = 'Дата в формате ГГГГ-ММ-ДД';
        break;
      case 'referral': {
        const list = a as ReferralAnswer[];
        if (!Array.isArray(list)) {
          errors[q.id] = 'Неверный формат рекомендации';
          break;
        }
        if (list.length > (q.maxItems ?? 3)) errors[q.id] = `Не больше ${q.maxItems ?? 3} контактов`;
        const bad = list.find((r) => !r || typeof r.name !== 'string' || !r.name.trim() || typeof r.phone !== 'string' || !PHONE_RE.test(r.phone.trim()));
        if (bad) errors[q.id] = 'У каждого контакта нужны имя и телефон из 11 цифр, например +7 913 123-45-67';
        break;
      }
    }
  }
  return errors;
}

/** Ответы только на видимые вопросы: скрытые условиями ответы не сохраняем. */
export function pruneAnswers(schema: SurveySchema, answers: Answers): Answers {
  const out: Answers = {};
  for (const q of visibleQuestions(schema, answers)) if (q.type !== 'info' && !isEmpty(answers[q.id])) out[q.id] = answers[q.id];
  return out;
}

export function npsOf(schema: SurveySchema, answers: Answers): number | null {
  const q = visibleQuestions(schema, answers).find((x) => x.type === 'nps');
  const a = q ? answers[q.id] : undefined;
  return typeof a === 'number' ? a : null;
}

/** Проверка самой анкеты перед публикацией. */
export function schemaProblems(schema: SurveySchema): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  if (!schema.questions.length) problems.push('В анкете нет вопросов');
  schema.questions.forEach((q, i) => {
    const n = `Вопрос ${i + 1}`;
    if (!q.id || ids.has(q.id)) problems.push(`${n}: повторяющийся идентификатор`);
    if (!q.title.trim()) problems.push(`${n}: нет текста вопроса`);
    if ((q.type === 'single' || q.type === 'multi') && !(q.options ?? []).length) problems.push(`${n}: нет вариантов ответа`);
    for (const c of q.showIf ?? []) if (!ids.has(c.questionId)) problems.push(`${n}: условие ссылается на вопрос, которого нет выше`);
    ids.add(q.id);
  });
  if (schema.questions.filter((q) => q.type === 'nps').length > 1) problems.push('В анкете может быть только один вопрос NPS');
  return problems;
}

export type NpsGroup = 'promoter' | 'passive' | 'detractor';
export const npsGroup = (n: number): NpsGroup => (n >= 9 ? 'promoter' : n >= 7 ? 'passive' : 'detractor');

/** NPS = % промоутеров − % критиков, округлённый до целого. */
export function npsScore(scores: number[]): number | null {
  if (!scores.length) return null;
  const p = scores.filter((s) => s >= 9).length;
  const d = scores.filter((s) => s <= 6).length;
  return Math.round(((p - d) / scores.length) * 100);
}

/** Подстановка имени клиента в текст скрипта. */
export function fillScript(text: string, client: { fullName: string }): string {
  const [last = '', first = '', middle = ''] = client.fullName.split(/\s+/);
  const firstName = first || last;
  return text
    .replaceAll('{имя}', firstName)
    .replaceAll('{отчество}', middle)
    .replaceAll('{имя отчество}', [firstName, middle].filter(Boolean).join(' '))
    .replaceAll('{фио}', client.fullName);
}

/** Первая версия анкеты: NPS, причины, партнёрская программа с перезвоном и рекомендацией. */
export const STARTER_SURVEY: SurveySchema = {
  intro: 'Здравствуйте, {имя отчество}! Меня зовут …, отдел контроля качества. Разговор записывается. Удобно ответить на пару вопросов, это займёт 2 минуты?',
  questions: [
    { id: 'nps', type: 'nps', title: 'Оценка NPS', script: 'По шкале от 0 до 10: насколько вероятно, что вы порекомендуете нас друзьям или знакомым?', required: true },
    {
      id: 'bad', type: 'multi', title: 'Что стоило сделать лучше', script: 'Что нам стоило сделать лучше?',
      showIf: [{ questionId: 'nps', op: 'lte', value: 6 }],
      options: ['Сроки', 'Качество работы', 'Цена', 'Общение менеджера', 'Документы'].map((label, i) => ({ id: `b${i + 1}`, label })),
    },
    {
      id: 'good', type: 'multi', title: 'Что понравилось', script: 'Что больше всего повлияло на вашу оценку?',
      showIf: [{ questionId: 'nps', op: 'gte', value: 7 }],
      options: ['Качество работы', 'Вежливость', 'Сроки', 'Цена', 'Помощь менеджера'].map((label, i) => ({ id: `g${i + 1}`, label })),
    },
    { id: 'comment', type: 'text', title: 'Комментарий клиента' },
    {
      id: 'partner', type: 'single', title: 'Партнёрская программа', required: true,
      script: 'У нас есть партнёрская программа: если по вашей рекомендации к нам обратятся, вы получите бонус. Есть ли человек, которому было бы полезно с нами связаться?',
      options: [
        { id: 'yes', label: 'Готов порекомендовать' },
        { id: 'later', label: 'Подумает, перезвонить', action: 'callback' },
        { id: 'no', label: 'Отказ' },
      ],
    },
    {
      id: 'referral', type: 'referral', title: 'Контакт рекомендации', required: true, maxItems: 3,
      showIf: [{ questionId: 'partner', op: 'eq', value: 'yes' }],
    },
  ],
  outro: 'Спасибо за ответы, хорошего дня!',
};
