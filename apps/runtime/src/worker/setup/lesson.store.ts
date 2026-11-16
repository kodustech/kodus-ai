import type { Lesson } from '@libs/runtime/blockers/lessons';

// runtime.runtime_lessons (docs §8): the worker writes them, from a setup that proved a
// fix and from an org admin's promote or retire; the API only reads them.

export const LESSON_STORE = Symbol('LESSON_STORE');

export interface LessonStore {
    /** A new lesson is inserted; the same one again counts one more time it helped. A retired lesson stays retired. */
    record(lesson: Lesson): Promise<void>;
    /** Applies an admin action to a lesson of that org; false when the org has no such lesson. */
    update(input: { lessonId: string; organizationId: string; action: 'promote' | 'retire'; by: string; at: string }): Promise<boolean>;
    /** The active lessons that apply to a repo: its own and the org's, never another org's (ADR-018). The learn loop reads them as data. */
    listForRepo?(organizationId: string, repositoryId: string): Promise<Lesson[]>;
}

/** The Runtime Postgres store (runtime.runtime_lessons). */
export { PgLessonStore } from '@libs/runtime/blockers/pg-lesson.store';

