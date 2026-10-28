import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../app.js';
import { HttpError } from '../auth/guard.js';
import { audit } from '../db/users.js';
import { schemaProblems, STARTER_SURVEY, type SurveySchema } from '../surveys/schema.js';

const idOf = (req: FastifyRequest) => Number((req.params as { id: string }).id);

/** Черновик из браузера: оставляем только известные поля и ограничиваем размер. */
function cleanSchema(input: unknown): SurveySchema {
  const s = (input ?? {}) as SurveySchema;
  if (!Array.isArray(s.questions)) throw new HttpError(400, 'bad_schema', 'Анкета должна содержать список вопросов');
  if (s.questions.length > 60) throw new HttpError(400, 'bad_schema', 'В анкете может быть не больше 60 вопросов');
  if (JSON.stringify(s).length > 200_000) throw new HttpError(400, 'bad_schema', 'Анкета слишком большая');
  return {
    intro: typeof s.intro === 'string' ? s.intro : '',
    outro: typeof s.outro === 'string' ? s.outro : '',
    questions: s.questions.map((q) => ({
      id: String(q.id),
      type: q.type,
      title: String(q.title ?? ''),
      script: typeof q.script === 'string' ? q.script : '',
      required: Boolean(q.required),
      ...(q.options ? { options: q.options.map((o) => ({ id: String(o.id), label: String(o.label ?? ''), ...(o.action ? { action: o.action } : {}) })) } : {}),
      ...(q.showIf?.length ? { showIf: q.showIf.map((c) => ({ questionId: String(c.questionId), op: c.op, value: c.value })) } : {}),
      ...(q.type === 'referral' ? { maxItems: Math.min(10, Math.max(1, Number(q.maxItems) || 3)) } : {}),
    })),
  };
}

export async function surveyRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, need } = ctx;

  app.get('/api/surveys', async (req) => {
    await need(req, 'surveys.view', 'surveys.edit');
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.archived, s.updated_at AS "updatedAt", v.version AS "activeVersion", v.published_at AS "publishedAt",
              (SELECT count(*) FROM responses r JOIN survey_versions x ON x.id = r.survey_version_id WHERE x.survey_id = s.id)::int AS responses,
              (s.draft::text <> COALESCE(v.schema::text, '')) AS "hasDraft"
         FROM surveys s LEFT JOIN survey_versions v ON v.id = s.active_version_id ORDER BY s.archived, s.id`,
    );
    return { items: rows };
  });

  app.get('/api/surveys/:id', async (req) => {
    await need(req, 'surveys.view', 'surveys.edit');
    const { rows } = await db.query(
      `SELECT s.id, s.name, s.archived, s.draft, v.schema AS published, v.version AS "activeVersion"
         FROM surveys s LEFT JOIN survey_versions v ON v.id = s.active_version_id WHERE s.id = $1`,
      [idOf(req)],
    );
    if (!rows[0]) throw new HttpError(404, 'not_found', 'Анкета не найдена');
    const versions = await db.query(
      `SELECT v.version, v.published_at AS "publishedAt", u.name AS "publishedBy" FROM survey_versions v
         LEFT JOIN users u ON u.id = v.published_by WHERE v.survey_id = $1 ORDER BY v.version DESC`,
      [idOf(req)],
    );
    return { ...rows[0], versions: versions.rows };
  });

  app.post('/api/surveys', async (req) => {
    const user = await need(req, 'surveys.edit');
    const { name, starter } = (req.body ?? {}) as { name?: string; starter?: boolean };
    if (!name?.trim()) throw new HttpError(400, 'bad_name', 'Введите название анкеты');
    const draft = starter ? STARTER_SURVEY : { intro: '', questions: [], outro: '' };
    const { rows } = await db.query<{ id: number }>('INSERT INTO surveys (name, draft) VALUES ($1, $2) RETURNING id', [name.trim(), draft]);
    await audit(db, user.id, 'survey_create', `survey:${rows[0].id}`, { name }, req.ip);
    return { id: rows[0].id };
  });

  // Сохранение черновика: сотрудники продолжают работать по опубликованной версии
  app.put('/api/surveys/:id', async (req) => {
    const user = await need(req, 'surveys.edit');
    const body = (req.body ?? {}) as { name?: string; draft?: unknown; archived?: boolean };
    const draft = cleanSchema(body.draft);
    const { rowCount } = await db.query(
      'UPDATE surveys SET name = COALESCE($2, name), draft = $3, archived = COALESCE($4, archived), updated_at = now() WHERE id = $1',
      [idOf(req), body.name?.trim() || null, draft, typeof body.archived === 'boolean' ? body.archived : null],
    );
    if (!rowCount) throw new HttpError(404, 'not_found', 'Анкета не найдена');
    await audit(db, user.id, 'survey_save', `survey:${idOf(req)}`, {}, req.ip);
    return { ok: true, problems: schemaProblems(draft) };
  });

  app.post('/api/surveys/:id/publish', async (req) => {
    const user = await need(req, 'surveys.publish');
    const id = idOf(req);
    const { rows } = await db.query<{ draft: SurveySchema }>('SELECT draft FROM surveys WHERE id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'Анкета не найдена');
    const problems = schemaProblems(rows[0].draft);
    if (problems.length) throw Object.assign(new HttpError(400, 'bad_schema', 'Анкету нельзя опубликовать'), { problems });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const v = await client.query<{ id: number; version: number }>(
        `INSERT INTO survey_versions (survey_id, version, schema, published_by)
         VALUES ($1, (SELECT COALESCE(max(version), 0) + 1 FROM survey_versions WHERE survey_id = $1), $2, $3) RETURNING id, version`,
        [id, rows[0].draft, user.id],
      );
      await client.query('UPDATE surveys SET active_version_id = $2, updated_at = now() WHERE id = $1', [id, v.rows[0].id]);
      await client.query('COMMIT');
      await audit(db, user.id, 'survey_publish', `survey:${id}`, { version: v.rows[0].version }, req.ip);
      return { version: v.rows[0].version };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}
