import { describe, expect, it } from 'vitest';
import {
  chosenAction, fillScript, npsOf, npsScore, pruneAnswers, schemaProblems, STARTER_SURVEY, validateAnswers, visibleQuestions,
} from '../src/surveys/schema.js';

const ids = (a: Record<string, unknown>) => visibleQuestions(STARTER_SURVEY, a as never).map((q) => q.id);

describe('условия показа вопросов', () => {
  it('без оценки причины не показываются', () => {
    expect(ids({})).toEqual(['nps', 'comment', 'partner']);
  });

  it('критику — «что сделать лучше», промоутеру — «что понравилось»', () => {
    expect(ids({ nps: 4 })).toContain('bad');
    expect(ids({ nps: 4 })).not.toContain('good');
    expect(ids({ nps: 9 })).toContain('good');
    expect(ids({ nps: 9 })).not.toContain('bad');
  });

  it('рекомендация — только при согласии', () => {
    expect(ids({ nps: 10, partner: 'yes' })).toContain('referral');
    expect(ids({ nps: 10, partner: 'no' })).not.toContain('referral');
  });

  it('вопрос, зависящий от скрытого, тоже скрыт', () => {
    const schema = {
      questions: [
        { id: 'a', type: 'yesno' as const, title: 'A' },
        { id: 'b', type: 'text' as const, title: 'B', showIf: [{ questionId: 'a', op: 'eq' as const, value: true }] },
        { id: 'c', type: 'text' as const, title: 'C', showIf: [{ questionId: 'b', op: 'answered' as const }] },
      ],
    };
    expect(visibleQuestions(schema, { a: false, b: 'x' }).map((q) => q.id)).toEqual(['a']);
    expect(visibleQuestions(schema, { a: true, b: 'x' }).map((q) => q.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('проверка ответов', () => {
  it('обязательные вопросы', () => {
    const e = validateAnswers(STARTER_SURVEY, {});
    expect(Object.keys(e).sort()).toEqual(['nps', 'partner']);
  });

  it('оценка вне шкалы — ошибка', () => {
    expect(validateAnswers(STARTER_SURVEY, { nps: 11, partner: 'no' }).nps).toBeDefined();
    expect(validateAnswers(STARTER_SURVEY, { nps: 7.5, partner: 'no' }).nps).toBeDefined();
  });

  it('при согласии нужен контакт с телефоном', () => {
    expect(validateAnswers(STARTER_SURVEY, { nps: 9, partner: 'yes' }).referral).toBe('Обязательный вопрос');
    expect(validateAnswers(STARTER_SURVEY, { nps: 9, partner: 'yes', referral: [{ name: 'Игорь', phone: '123' }] }).referral).toBeDefined();
    expect(validateAnswers(STARTER_SURVEY, { nps: 9, partner: 'yes', referral: [{ name: 'Игорь', phone: '+7 (913) 123-45-67' }] })).toEqual({});
  });

  it('вариант не из списка — ошибка', () => {
    expect(validateAnswers(STARTER_SURVEY, { nps: 9, partner: 'maybe' }).partner).toBeDefined();
    expect(validateAnswers(STARTER_SURVEY, { nps: 9, good: ['g1', 'zzz'], partner: 'no' }).good).toBeDefined();
  });

  it('при перезвоне обязательные можно не заполнять', () => {
    expect(validateAnswers(STARTER_SURVEY, { partner: 'later' }, { partial: true })).toEqual({});
  });

  it('скрытые ответы не сохраняются', () => {
    const stored = pruneAnswers(STARTER_SURVEY, { nps: 9, bad: ['b1'], good: ['g2'], partner: 'no', referral: [{ name: 'x', phone: '79131234567' }] });
    expect(stored).toEqual({ nps: 9, good: ['g2'], partner: 'no' });
  });
});

describe('действия вариантов и NPS', () => {
  it('«подумает, перезвонить» требует перезвона', () => {
    expect(chosenAction(STARTER_SURVEY, { nps: 8, partner: 'later' })).toBe('callback');
    expect(chosenAction(STARTER_SURVEY, { nps: 8, partner: 'no' })).toBeNull();
  });

  it('NPS считается как % промоутеров минус % критиков', () => {
    expect(npsScore([])).toBeNull();
    expect(npsScore([10, 9, 8, 7, 3])).toBe(20);
    expect(npsScore([0, 0, 10])).toBe(-33);
    expect(npsOf(STARTER_SURVEY, { nps: 6 })).toBe(6);
  });

  it('стартовая анкета проходит проверку перед публикацией', () => {
    expect(schemaProblems(STARTER_SURVEY)).toEqual([]);
  });

  it('проблемы анкеты находятся', () => {
    const p = schemaProblems({
      questions: [
        { id: 'a', type: 'single', title: '' },
        { id: 'a', type: 'nps', title: 'x', showIf: [{ questionId: 'zzz', op: 'answered' }] },
      ],
    });
    expect(p.join('\n')).toMatch(/нет текста/);
    expect(p.join('\n')).toMatch(/нет вариантов/);
    expect(p.join('\n')).toMatch(/повторяющийся/);
    expect(p.join('\n')).toMatch(/условие ссылается/);
  });

  it('подстановка имени в скрипт', () => {
    expect(fillScript('Здравствуйте, {имя отчество}!', { fullName: 'Смирнова Елена Викторовна' })).toBe('Здравствуйте, Елена Викторовна!');
  });
});
