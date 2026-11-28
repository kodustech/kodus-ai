// Test doubles (libs/runtime/AGENTS.md): specs and dev wiring import them, production code never does.
import type { EnvSessionRow, EnvSessionStore, EnvStepRow } from './env-session.store';

export class InMemoryEnvSessionStore implements EnvSessionStore {
    readonly sessions = new Map<string, EnvSessionRow>();
    readonly steps = new Map<string, EnvStepRow>();

    async insert(row: EnvSessionRow) {
        if (this.sessions.has(row.sessionId)) return false;
        this.sessions.set(row.sessionId, structuredClone(row));
        return true;
    }
    async get(organizationId: string, sessionId: string) {
        const r = this.sessions.get(sessionId);
        return r && r.organizationId === organizationId ? structuredClone(r) : null;
    }
    async update(organizationId: string, sessionId: string, patch: Partial<EnvSessionRow>) {
        const r = this.sessions.get(sessionId);
        // The pin and the layout are fixed at insert.
        const { repositories: _layout, ...mutable } = patch;
        if (r && r.organizationId === organizationId) this.sessions.set(sessionId, { ...r, ...mutable, validationSnapshot:r.validationSnapshot });
    }
    async listLive(organizationId: string) {
        return [...this.sessions.values()]
            .filter((s) => s.organizationId === organizationId && (s.state === 'acquiring' || s.state === 'ready'))
            .map((s) => structuredClone(s));
    }
    async listStale(idleBefore: string, now: string, limit: number) {
        return [...this.sessions.values()]
            .filter((s) => (s.state === 'acquiring' || s.state === 'ready') && (s.lastUsedAt < idleBefore || (!!s.leaseExpiresAt && s.leaseExpiresAt < now)))
            .slice(0, limit)
            .map((s) => structuredClone(s));
    }
    async insertStep(row: EnvStepRow) {
        this.steps.set(row.stepId, { ...row });
    }
    async getStep(organizationId: string, stepId: string) {
        const r = this.steps.get(stepId);
        return r && r.organizationId === organizationId ? { ...r } : null;
    }
    async finishStep(organizationId: string, stepId: string, patch: Pick<EnvStepRow, 'state' | 'finishedAt' | 'result'>) {
        const r = this.steps.get(stepId);
        if (r && r.organizationId === organizationId) this.steps.set(stepId, { ...r, ...patch });
    }
}
