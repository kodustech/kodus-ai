import type { Lesson } from '@libs/runtime/blockers/lessons';

// runtime_lessons (docs §8): the worker writes them, from a setup that proved a
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

/** The Mongo calls the store makes (a Collection<Lesson> satisfies it). */
export interface LessonCollection {
    updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options?: { upsert?: boolean }): Promise<{ matchedCount: number }>;
    find?(filter: Record<string, unknown>, options: { projection: { _id: 0 }; sort: Record<string, 1 | -1>; limit: number }): { toArray(): Promise<unknown[]> };
}

const LESSONS_READ = 50;

export class MongoLessonStore implements LessonStore {
    constructor(private readonly coll: LessonCollection) {}

    static async ensureIndexes(coll: { createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown> }) {
        await coll.createIndex({ lessonId: 1 }, { unique: true });
        await coll.createIndex({ organizationId: 1, signature: 1 });
    }

    async record(lesson: Lesson) {
        const { helped: _h, lastAt, state: _s, ...first } = lesson;
        await this.coll.updateOne(
            { lessonId: lesson.lessonId, organizationId: lesson.organizationId },
            { $setOnInsert: { ...first, state: 'active' }, $inc: { helped: 1 }, $set: { lastAt } },
            { upsert: true },
        );
    }

    async listForRepo(organizationId: string, repositoryId: string) {
        if (!this.coll.find) return [];
        const docs = await this.coll
            .find(
                { organizationId, state: 'active', $or: [{ scope: 'org' }, { repositoryId }] },
                { projection: { _id: 0 }, sort: { helped: -1, lastAt: -1 }, limit: LESSONS_READ },
            )
            .toArray();
        return (docs as Lesson[]).filter((l) => l.organizationId === organizationId);
    }

    async update(input: { lessonId: string; organizationId: string; action: 'promote' | 'retire'; by: string; at: string }) {
        const set =
            input.action === 'promote'
                ? { scope: 'org', promotedBy: input.by, promotedAt: input.at }
                : { state: 'retired', retiredBy: input.by, retiredAt: input.at };
        const r = await this.coll.updateOne({ lessonId: input.lessonId, organizationId: input.organizationId }, { $set: set });
        return r.matchedCount > 0;
    }
}

export class InMemoryLessonStore implements LessonStore {
    readonly byId = new Map<string, Lesson>();

    async listForRepo(organizationId: string, repositoryId: string) {
        return [...this.byId.values()].filter(
            (l) => l.organizationId === organizationId && l.state === 'active' && (l.scope === 'org' || l.repositoryId === repositoryId),
        );
    }

    async record(lesson: Lesson) {
        const prev = this.byId.get(lesson.lessonId);
        if (prev && prev.organizationId === lesson.organizationId) {
            this.byId.set(lesson.lessonId, { ...prev, helped: prev.helped + 1, lastAt: lesson.lastAt });
        } else if (!prev) {
            this.byId.set(lesson.lessonId, { ...lesson });
        }
    }

    async update(input: { lessonId: string; organizationId: string; action: 'promote' | 'retire'; by: string; at: string }) {
        const l = this.byId.get(input.lessonId);
        if (!l || l.organizationId !== input.organizationId) return false;
        this.byId.set(
            l.lessonId,
            input.action === 'promote'
                ? { ...l, scope: 'org', promotedBy: input.by, promotedAt: input.at }
                : { ...l, state: 'retired', retiredBy: input.by, retiredAt: input.at },
        );
        return true;
    }
}
