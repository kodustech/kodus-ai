import { randomUUID } from 'crypto';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { PermissionsAbilityFactory } from '@libs/identity/infrastructure/adapters/services/permissions/permissionsAbility.factory';
import { InMemoryRunProjectionStore, openSecret, sealingKeyFrom, type RuntimeRunProjection } from '@libs/runtime/run';

import type {
    FindingFeedbackRecord,
    FindingFeedbackStore,
    FindingIntentRecord,
    FindingIntentStore,
    RuntimeApiConfig,
    RuntimeLlmUsageRecord,
    RuntimeLlmUsageStore,
    RuntimeLlmRunUsage,
    RuntimeLlmSettledUsage,
} from '../domain/ports';

export const ORG = 'org-a';
export const OTHER_ORG = 'org-b';
export const TEAM = 'team-a';
export const REPO = 'repo-1';
export const OTHER_REPO = 'repo-2';
export const SHA = 'a'.repeat(40);
export const BASE_SHA = 'b'.repeat(40);
export const NOW = new Date('2026-10-29T12:00:00.000Z');
export const SECRET = 'x'.repeat(48);
/** RUNTIME_SECRET_SEAL_KEY of the tests (32 bytes as hex). */
export const SEAL_KEY = '7'.repeat(64);
/** Opens a token the product sealed for that Run (or setup key), as the runtime-worker does. */
export const openSealed = (sealed: string, boundTo: string) => openSecret(sealed, sealingKeyFrom(SEAL_KEY), boundTo);

export const user = (role: Role, opts: { org?: string; uuid?: string } = {}) => ({
    uuid: opts.uuid ?? `user-${role}`,
    email: `${role}@example.test`,
    role,
    status: STATUS.ACTIVE,
    organization: { uuid: opts.org ?? ORG },
});

/** Real RBAC (ROLE_POLICIES through the CASL factory); repo admins are assigned REPO only. */
export const realAuthorization = (assigned: string[] = [REPO]) =>
    new AuthorizationService(
        new PermissionsAbilityFactory({
            findOne: async () => ({ permissions: { assignedRepositoryIds: assigned } }),
        } as any),
    );

export const run = (patch: Partial<RuntimeRunProjection> = {}): RuntimeRunProjection => ({
    runId: randomUUID(),
    attempt: 1,
    correlationId: 'corr-1',
    organizationId: ORG,
    teamId: TEAM,
    repositoryId: REPO,
    repositoryName: 'acme/shop',
    prNumber: 7,
    headSha: SHA,
    baseSha: BASE_SHA,
    environmentId: 'env-1',
    imageId: 'img-1',
    state: 'regression',
    requestedAt: '2026-10-29T11:00:00.000Z',
    updatedAt: '2026-10-29T11:10:00.000Z',
    ...patch,
});

export async function storeWith(...runs: RuntimeRunProjection[]) {
    const store = new InMemoryRunProjectionStore();
    for (const r of runs) await store.upsert(r.runId, r);
    return store;
}

export const config = (patch: Partial<RuntimeApiConfig> = {}): RuntimeApiConfig => ({
    runTokenSecret: SECRET,
    evidenceSigningSecret: SECRET,
    evidenceBaseUrl: 'https://evidence.runtime.example.test',
    evidenceTtlSeconds: 300,
    pool: { defaultSize: 1, maxSize: 3 },
    machineSize: { maxPreset: 'large' },
    llmBudget: { perRun: 1_000, perPullRequest: 2_500, perOrgPerDay: 10_000 },
    oncallUserIds: ['oncall-1'],
    egressDenylist: [],
    streamLongPollMs: 200,
    streamPollIntervalMs: 20,
    secretSealKey: SEAL_KEY,
    ...patch,
});

export class FakeOutbox {
    readonly rows: any[] = [];
    async create(row: any) {
        this.rows.push(row);
    }
    async createBatch(rows: any[]) {
        this.rows.push(...rows);
        return rows;
    }
    get events() {
        return this.rows.map((r) => r.payload.event_name);
    }
}

export class InMemoryLlmUsage implements RuntimeLlmUsageStore {
    readonly rows: Array<RuntimeLlmUsageRecord & { id?: string; pending?: boolean } & Partial<Pick<RuntimeLlmSettledUsage, 'model' | 'cacheReadTokens' | 'cacheWriteTokens'>>> = [];
    private seq = 0;
    /** Test seeding: usage already spent before the call under test. */
    async record(u: RuntimeLlmUsageRecord) {
        this.rows.push(u);
    }
    // No await between the sum and the push: atomic, like the counters' compare-and-swap.
    async reserve(input: Parameters<RuntimeLlmUsageStore['reserve']>[0]) {
        const u = input.usage;
        const tokens = input.decide({
            run: this.sum(this.rows.filter((r) => r.runId === u.runId)),
            pullRequest: this.sum(this.rows.filter((r) => r.organizationId === u.organizationId && r.repositoryId === u.repositoryId && r.prNumber === u.prNumber)),
            orgToday: this.sum(this.rows.filter((r) => r.organizationId === u.organizationId && r.at >= input.orgDayStart)),
        });
        if (tokens === null) return null;
        const id = `res-${++this.seq}`;
        this.rows.push({ ...u, inputTokens: tokens, outputTokens: 0, id, pending: true });
        return { reservationId: id, tokens };
    }
    async settle(id: string, actual: RuntimeLlmSettledUsage) {
        const row = this.rows.find((r) => r.id === id);
        if (row) Object.assign(row, actual, { pending: false });
    }
    async usageForRuns(runIds: string[]) {
        const out = new Map<string, RuntimeLlmRunUsage>();
        for (const runId of new Set(runIds)) {
            const rows = this.rows.filter((r) => r.runId === runId);
            if (!rows.length) continue;
            const byModel = new Map<string | undefined, RuntimeLlmRunUsage['byModel'][number]>();
            for (const r of rows.filter((x) => !x.pending)) {
                const m = byModel.get(r.model) ?? { model: r.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
                m.inputTokens += r.inputTokens;
                m.outputTokens += r.outputTokens;
                m.cacheReadTokens += r.cacheReadTokens ?? 0;
                m.cacheWriteTokens += r.cacheWriteTokens ?? 0;
                byModel.set(r.model, m);
            }
            out.set(runId, { tokens: this.sum(rows), byModel: [...byModel.values()] });
        }
        return out;
    }
    async cancel(id: string) {
        const i = this.rows.findIndex((r) => r.id === id);
        if (i >= 0) this.rows.splice(i, 1);
    }
    private sum(rows: RuntimeLlmUsageRecord[]) {
        return rows.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
    }
    async totalForRun(runId: string) {
        return this.sum(this.rows.filter((r) => r.runId === runId));
    }
    async totalForPullRequest(k: { organizationId: string; repositoryId: string; prNumber: number }) {
        return this.sum(
            this.rows.filter((r) => r.organizationId === k.organizationId && r.repositoryId === k.repositoryId && r.prNumber === k.prNumber),
        );
    }
    async totalForOrganizationSince(organizationId: string, since: Date) {
        return this.sum(this.rows.filter((r) => r.organizationId === organizationId && r.at >= since));
    }
}

export const clock = () => NOW;

export class InMemoryFindingIntent implements FindingIntentStore {
    rows: FindingIntentRecord[] = [];
    async listForRun(organizationId: string, runId: string) {
        return this.rows.filter((r) => r.organizationId === organizationId && r.runId === runId);
    }
    async set(input: Parameters<FindingIntentStore['set']>[0]) {
        const same = (r: FindingIntentRecord) => r.runId === input.runId && r.probeId === input.probeId;
        this.rows = this.rows.filter((r) => !same(r));
        const { intended, ...row } = input;
        if (intended) this.rows.push({ ...row, markedAt: NOW.toISOString() });
    }
}

export class InMemoryFindingFeedback implements FindingFeedbackStore {
    rows: FindingFeedbackRecord[] = [];
    async listForRun(organizationId: string, runId: string) {
        return this.rows.filter((r) => r.organizationId === organizationId && r.runId === runId);
    }
    async set(input: Parameters<FindingFeedbackStore['set']>[0]) {
        const same = (r: FindingFeedbackRecord) => r.runId === input.runId && r.probeId === input.probeId && r.userId === input.userId;
        this.rows = this.rows.filter((r) => !same(r));
        if (input.value) this.rows.push({ ...input, value: input.value, updatedAt: NOW.toISOString() });
    }
}
