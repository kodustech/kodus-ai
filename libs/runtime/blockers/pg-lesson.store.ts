import { DocumentTable, jsonb } from '@libs/runtime/run/adapters/pg-document';
import type { SqlQuery } from '@libs/runtime/run/adapters/pg-sql';

import type { Lesson } from './lessons';

// Lessons in the Runtime Postgres (runtime.runtime_lessons, docs §8): the
// runtime-worker writes them, from a setup that proved a fix and from an org
// admin's promote or retire; the API reads them with the read-only role.

export const RUNTIME_LESSONS_TABLE = 'runtime.runtime_lessons';

/** What the reads filter and sort on; the catalog's texts, the fix and the origin are `lesson`. */
export const LESSON_COLUMNS = new DocumentTable<Lesson>(
    [
        ['lessonId', 'lesson_id', 'text'],
        ['organizationId', 'organization_id', 'text'],
        ['repositoryId', 'repository_id', 'text'],
        ['environmentId', 'environment_id', 'text'],
        ['scope', 'scope', 'text'],
        ['signature', 'signature', 'text'],
        ['state', 'state', 'text'],
        ['helped', 'helped', 'integer'],
        ['firstAt', 'first_at', 'timestamptz'],
        ['lastAt', 'last_at', 'timestamptz'],
    ],
    'lesson',
);

/** The active lessons the learn loop reads for one repository. */
const LESSONS_READ = 50;
/** The Lessons screen of an org. */
const ORG_LESSONS_READ = 500;

export class PgLessonReads {
    constructor(protected readonly db: SqlQuery) {}

    /** The org's active lessons, the most recent first. */
    async listByOrganization(organizationId: string): Promise<Lesson[]> {
        const res = await this.db.query(
            `SELECT ${LESSON_COLUMNS.selectList} FROM ${RUNTIME_LESSONS_TABLE}
             WHERE organization_id = $1 AND state = 'active' ORDER BY last_at DESC LIMIT ${ORG_LESSONS_READ}`,
            [organizationId],
        );
        return res.rows.map((r) => LESSON_COLUMNS.read(r));
    }
}

export class PgLessonStore extends PgLessonReads {
    /** A new lesson is inserted active, helped once; the same one again counts one more time it helped. A retired one stays retired. */
    async record(lesson: Lesson): Promise<void> {
        const split = LESSON_COLUMNS.split({ ...lesson, helped: 1, state: 'active' } as Record<string, unknown>);
        const columns = [...split.columns, 'lesson'];
        await this.db.query(
            `INSERT INTO ${RUNTIME_LESSONS_TABLE} AS l (${columns.join(', ')})
             VALUES (${columns.map((c, i) => (c === 'lesson' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})
             ON CONFLICT (lesson_id) DO UPDATE SET helped = l.helped + 1, last_at = EXCLUDED.last_at
             WHERE l.organization_id = EXCLUDED.organization_id`,
            [...split.values, jsonb(split.rest)],
        );
    }

    /** The active lessons that apply to a repo: its own and the org's, never another org's (ADR-018). */
    async listForRepo(organizationId: string, repositoryId: string): Promise<Lesson[]> {
        const res = await this.db.query(
            `SELECT ${LESSON_COLUMNS.selectList} FROM ${RUNTIME_LESSONS_TABLE}
             WHERE organization_id = $1 AND state = 'active' AND (scope = 'org' OR repository_id = $2)
             ORDER BY helped DESC, last_at DESC LIMIT ${LESSONS_READ}`,
            [organizationId, repositoryId],
        );
        return res.rows.map((r) => LESSON_COLUMNS.read(r));
    }

    /** An admin's promote or retire of a lesson of that org; false when the org has no such lesson. */
    async update(input: { lessonId: string; organizationId: string; action: 'promote' | 'retire'; by: string; at: string }): Promise<boolean> {
        const res =
            input.action === 'promote'
                ? await this.db.query(
                      `UPDATE ${RUNTIME_LESSONS_TABLE} SET scope = 'org', lesson = lesson || jsonb_build_object('promotedBy', $3::text, 'promotedAt', $4::text)
                       WHERE lesson_id = $1 AND organization_id = $2`,
                      [input.lessonId, input.organizationId, input.by, input.at],
                  )
                : await this.db.query(
                      `UPDATE ${RUNTIME_LESSONS_TABLE} SET state = 'retired', lesson = lesson || jsonb_build_object('retiredBy', $3::text, 'retiredAt', $4::text)
                       WHERE lesson_id = $1 AND organization_id = $2`,
                      [input.lessonId, input.organizationId, input.by, input.at],
                  );
        return (res.rowCount ?? 0) > 0;
    }
}
