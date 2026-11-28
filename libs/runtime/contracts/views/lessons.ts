import type { Lesson } from '@libs/runtime/blockers/lessons';

// What GET /runtime/environments/:id/lessons answers: types only, shared by
// the use case (api/application/use-cases/lessons.use-cases.ts) and the web.

/** A lesson as the product shows it: problem, cause, the fix that worked and where it was proven. */
export type RuntimeLessonView = Pick<
    Lesson,
    'lessonId' | 'scope' | 'signature' | 'kind' | 'problem' | 'cause' | 'fix' | 'helped' | 'firstAt' | 'lastAt' | 'promotedAt'
> & {
    origin: { sha: string; branch?: string; at: string; repositoryId: string };
};
