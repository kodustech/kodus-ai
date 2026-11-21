import { randomUUID } from 'crypto';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { PermissionsAbilityFactory } from '@libs/identity/infrastructure/adapters/services/permissions/permissionsAbility.factory';
import { openSecret, sealingKeyFrom, type RuntimeRunProjection } from '@libs/runtime/run';

import { MAX_WORKSPACE_REPOSITORIES, REPOSITORY_ALIAS_PATTERN } from '@libs/runtime/contracts/workspace';

import {
    EnvironmentRepositoryConflictError,
    type EnvironmentRepository,
    type EnvironmentRepositoryPatch,
    type EnvironmentRepositoryStore,
} from '../domain/ports';
import type { RuntimeLlmSpendRow } from '../domain/llm-spend';
import type {
    FindingFeedbackRecord,
    FindingFeedbackStore,
    FindingIntentRecord,
    FindingIntentStore,
    KeptCheckRecord,
    KeptCheckResultsReader,
    KeptCheckResultSummary,
    KeptCheckStore,
    RuntimeApiConfig,
    RuntimeLlmUsageRecord,
    RuntimeLlmUsageStore,
    RuntimeLlmSettledUsage,
    RuntimeLlmSpendReader,
} from '../domain/ports';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';

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

/** One priced bucket of usage spans, as TelemetryRuntimeLlmSpendReader returns it. */
export const spendRow = (patch: Partial<RuntimeLlmSpendRow> = {}): RuntimeLlmSpendRow => ({
    runId: 'run-1',
    agent: 'run_agent',
    repositoryId: REPO,
    environmentId: null,
    model: 'claude-sonnet-4-5',
    paidBy: 'kodus',
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 1_100,
    aboveBaseTierTokens: 0,
    usd: 0.0045,
    ...patch,
});

/** The usage spans of an org (observability_telemetry), already priced; the reads it served are kept. */
export class InMemoryLlmSpend implements RuntimeLlmSpendReader {
    reads: Array<Parameters<RuntimeLlmSpendReader['spendOf']>[0]> = [];
    constructor(public rows: Array<RuntimeLlmSpendRow & { organizationId?: string; at?: Date }> = []) {}
    async spendOf(query: Parameters<RuntimeLlmSpendReader['spendOf']>[0]) {
        this.reads.push(query);
        return this.rows.filter(
            (r) =>
                (r.organizationId ?? ORG) === query.organizationId &&
                (!query.runIds || (r.runId !== null && query.runIds.includes(r.runId))) &&
                (!r.at || (r.at >= query.start && r.at < query.end)),
        );
    }
}

export class InMemoryLlmUsage implements RuntimeLlmUsageStore {
    readonly rows: Array<RuntimeLlmUsageRecord & { id?: string; pending?: boolean } & Partial<Pick<RuntimeLlmSettledUsage, 'model' | 'cacheReadTokens' | 'cacheWriteTokens' | 'failedAttempt'>>> = [];
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
            pullRequest: this.sum(this.rows.filter((r) => !r.failedAttempt && r.organizationId === u.organizationId && r.repositoryId === u.repositoryId && r.prNumber === u.prNumber)),
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
            this.rows.filter((r) => !r.failedAttempt && r.organizationId === k.organizationId && r.repositoryId === k.repositoryId && r.prNumber === k.prNumber),
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

/** runtime_kept_checks in memory, with the semantics of TypeOrmKeptCheckStore: org-scoped, one active check per key, a cap. */
export class InMemoryKeptChecks implements KeptCheckStore {
    rows: Array<KeptCheckRecord & { removedAt?: string; removedBy?: string }> = [];
    async listActive(organizationId: string, scope: { environmentId: string; repositoryId?: string }, limit: number) {
        return this.rows
            .filter((r) => !r.removedAt && r.organizationId === organizationId && r.environmentId === scope.environmentId && (!scope.repositoryId || r.repositoryId === scope.repositoryId))
            .slice(0, limit);
    }
    async get(organizationId: string, keptCheckId: string) {
        return this.rows.find((r) => !r.removedAt && r.organizationId === organizationId && r.keptCheckId === keptCheckId) ?? null;
    }
    async keep(input: Omit<KeptCheckRecord, 'keptCheckId' | 'keptAt'>, max: number) {
        const scope = this.rows.filter((r) => !r.removedAt && r.organizationId === input.organizationId && r.environmentId === input.environmentId && r.repositoryId === input.repositoryId);
        const same = scope.find((r) => r.probeKey === input.probeKey);
        if (same) return { record: same, created: false };
        if (scope.length >= max) return { full: true as const };
        const record = { ...input, keptCheckId: randomUUID(), keptAt: NOW.toISOString() };
        this.rows.push(record);
        return { record, created: true };
    }
    async remove(organizationId: string, keptCheckId: string, removedBy: string) {
        const row = this.rows.find((r) => !r.removedAt && r.organizationId === organizationId && r.keptCheckId === keptCheckId);
        if (!row) return false;
        Object.assign(row, { removedAt: NOW.toISOString(), removedBy });
        return true;
    }
}

/** runtime_kept_check_results as the API reads them, in memory; `unavailable` reads as the 503 of a Runtime database it cannot see. */
export class InMemoryKeptCheckResults implements KeptCheckResultsReader {
    summaryRows: KeptCheckResultSummary[] = [];
    total = 0;
    unavailable = false;
    async summaries(_organizationId: string, ids: string[]) {
        if (this.unavailable) throw new Error('Runtime database is not configured');
        return this.summaryRows.filter((r) => ids.includes(r.keptCheckId));
    }
    async failuresOnLaterPrs() {
        if (this.unavailable) throw new Error('Runtime database is not configured');
        return this.total;
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

/**
 * runtime_environment_repositories in memory, with the semantics of
 * TypeOrmEnvironmentRepositoryStore (environment-repositories.contract.ts
 * holds both to them). `environments` are the environments that exist, by org.
 */
export class InMemoryEnvironmentRepositories implements EnvironmentRepositoryStore {
    rows: EnvironmentRepository[] = [];
    private tick = 0;

    constructor(readonly environments: Array<{ environmentId: string; organizationId: string }> = []) {}

    async listByEnvironment(organizationId: string, environmentId: string) {
        return this.rows
            .filter((r) => r.organizationId === organizationId && r.environmentId === environmentId)
            .sort((a, b) => (a.role === b.role ? (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0) : a.role === 'primary' ? -1 : 1))
            .map((r) => ({ ...r }));
    }

    async listByRepository(organizationId: string, repositoryId: string) {
        return this.rows.filter((r) => r.organizationId === organizationId && r.repositoryId === repositoryId).map((r) => ({ ...r }));
    }

    async listByEnvironments(organizationId: string, environmentIds: readonly string[]) {
        return (await Promise.all([...new Set(environmentIds)].map((id) => this.listByEnvironment(organizationId, id)))).flat();
    }

    async listByRepositories(organizationId: string, repositoryIds: readonly string[]) {
        const ids = new Set(repositoryIds);
        return this.rows.filter((r) => r.organizationId === organizationId && ids.has(r.repositoryId)).map((r) => ({ ...r }));
    }

    async add(input: Omit<EnvironmentRepository, 'createdAt' | 'updatedAt'>) {
        if (!REPOSITORY_ALIAS_PATTERN.test(input.alias)) throw new Error('invalid repository alias');
        if (!this.environments.some((e) => e.environmentId === input.environmentId && e.organizationId === input.organizationId)) return null;
        const existing = this.find(input.organizationId, input.environmentId, input.repositoryId);
        if (existing) return { ...existing };
        const siblings = this.rows.filter((r) => r.environmentId === input.environmentId);
        if (input.role === 'primary' && siblings.some((r) => r.role === 'primary')) throw new EnvironmentRepositoryConflictError('primary');
        if (siblings.some((r) => r.alias === input.alias)) throw new EnvironmentRepositoryConflictError('alias');
        if (input.role === 'member' && siblings.filter((r) => r.role === 'member').length >= MAX_WORKSPACE_REPOSITORIES - 1) throw new EnvironmentRepositoryConflictError('limit');
        const at = this.now();
        const row = { ...input, createdAt: at, updatedAt: at };
        this.rows.push(row);
        return { ...row };
    }

    async remove(organizationId: string, environmentId: string, repositoryId: string) {
        const row = this.find(organizationId, environmentId, repositoryId);
        if (!row || row.role !== 'member') return false;
        this.rows = this.rows.filter((r) => r !== row);
        return true;
    }

    async update(organizationId: string, environmentId: string, repositoryId: string, patch: EnvironmentRepositoryPatch) {
        if (patch.alias !== undefined && !REPOSITORY_ALIAS_PATTERN.test(patch.alias)) throw new Error('invalid repository alias');
        const row = this.find(organizationId, environmentId, repositoryId);
        if (!row) return null;
        if (patch.alias !== undefined && this.rows.some((r) => r !== row && r.environmentId === environmentId && r.alias === patch.alias)) {
            throw new EnvironmentRepositoryConflictError('alias');
        }
        const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        if (Object.keys(set).length) Object.assign(row, set, { updatedAt: this.now() });
        return { ...row };
    }

    private find(organizationId: string, environmentId: string, repositoryId: string) {
        return this.rows.find((r) => r.organizationId === organizationId && r.environmentId === environmentId && r.repositoryId === repositoryId);
    }

    private now() {
        return new Date(NOW.getTime() + this.tick++).toISOString();
    }
}

/**
 * Counts the calls made to an object's methods: every method of a store is
 * one query, so a use case's reads can be counted (the WP1 and WP3 measures).
 */
export function counted<T extends object>(target: T): { store: T; calls: string[] } {
    const calls: string[] = [];
    const store = new Proxy(target, {
        get(t, key, receiver) {
            const value = Reflect.get(t, key, receiver);
            if (typeof value !== 'function' || typeof key !== 'string') return value;
            return (...args: unknown[]) => {
                calls.push(key);
                return (value as (...a: unknown[]) => unknown).apply(t, args);
            };
        },
    });
    return { store, calls };
}

/** The Runtime release gate of an org on the alpha track with the flag on (or off, for the refusal tests). */
export const runtimeReleaseGate = (enabled: boolean | ((organizationId: string | undefined) => boolean) = true) => ({
    asked: [] as Array<string | undefined>,
    async isEnabledFor(organizationId: string | undefined) {
        this.asked.push(organizationId);
        return typeof enabled === 'function' ? enabled(organizationId) : enabled;
    },
});
