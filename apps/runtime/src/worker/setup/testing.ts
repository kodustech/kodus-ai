// Test doubles (libs/runtime/AGENTS.md): specs and dev wiring import them, production code never does.
import type { Lesson } from '@libs/runtime/blockers/lessons';
import type { EnvironmentSetupProgress, EnvironmentSetupRecord } from '@libs/runtime/run';

import type { EnvironmentSetupStore } from './environment-setup.store';
import type { LessonStore } from './lesson.store';

export class InMemoryEnvironmentSetupStore implements EnvironmentSetupStore {
    readonly saved: EnvironmentSetupRecord[] = [];
    private readonly byId = new Map<string, EnvironmentSetupRecord>();

    async get(environmentId: string) {
        return this.byId.get(environmentId) ?? null;
    }

    async save(record: EnvironmentSetupRecord) {
        const copy = JSON.parse(JSON.stringify(record)) as EnvironmentSetupRecord;
        this.byId.set(record.environmentId, copy);
        this.saved.push(copy);
    }

    async saveProgress(environmentId: string, key: string, progress: EnvironmentSetupProgress) {
        const r = this.byId.get(environmentId);
        if (r && r.key === key && r.state === 'setting_up') r.progress = JSON.parse(JSON.stringify(progress));
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
