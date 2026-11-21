import { EnvironmentRuntime, FakeEnvironmentRuntime, isBlocked } from '@libs/runtime/environment';
import type { RuntimePublishRequested } from '@libs/runtime/run';
import { InMemoryRunProjectionStore, InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { SCENARIOS } from '../../fake-cell/scenarios';
import { RecordedLlmGateway, RecordedTurn } from '../agent/llm-gateway';
import { RuntimeAgent } from '../agent/runtime-agent';
import { CanaryGuardedLlmGateway, CanaryVault, HmacCanaryVault, isCanaryLeak } from '../canary/canary';
import { IntentAuthor } from '../intent/intent-author';
import { IntentClassifier } from '../intent/intent-classifier';
import shopTurns from '../agent/fixtures/shop-orders.json';
import type { RunClaims, RunDeps, RunLogEvent } from './ports';

/**
 * The hub's claim rows, in memory: the environment below records a claim on
 * acquire and releases it on release, like the hub does in runtime_claims.
 */
export class InMemoryRunClaims implements RunClaims {
    readonly claims = new Map<string, { claimId: string; cellId: string; runId: string; organizationId: string; side: string; released: boolean; hardExpiresAt: string }>();
    /** Rows the hub recorded; without `organizationId` a row belongs to its claim's org. */
    readonly egress: { claimId: string; organizationId?: string; host: string; port: number; phase: string; runId?: string; side?: string }[] = [];
    readonly violations: { claimId: string; organizationId?: string; side: string; signature: string }[] = [];

    async record(c: { claimId: string; cellId: string; runId: string; organizationId: string; side: 'base' | 'pr'; hardExpiresAt: string }) {
        if (!this.claims.has(c.claimId)) this.claims.set(c.claimId, { ...c, released: false });
    }
    async forRun(organizationId: string, runId: string) {
        return [...this.claims.values()].filter((c) => c.runId === runId && c.organizationId === organizationId && !c.released);
    }
    async markReleased(claimId: string) {
        const c = this.claims.get(claimId);
        if (c) c.released = true;
    }
    async egressBlocked(organizationId: string, claimIds: string[]) {
        return this.egress.filter((e) => claimIds.includes(e.claimId) && this.orgOf(e) === organizationId).map(({ host, port, phase }) => ({ host, port, phase }));
    }
    /** A row's run and side come from its claim, or from the row itself for a claim the fake never recorded (one that failed). */
    async deniedEgressOfRun(organizationId: string, runId: string) {
        return this.egress
            .map((e) => ({ e, claim: this.claims.get(e.claimId) }))
            .filter(({ e, claim }) => (e.runId ?? claim?.runId) === runId && this.orgOf(e) === organizationId)
            .map(({ e, claim }) => ({ side: e.side ?? claim?.side ?? '', host: e.host }));
    }
    async securityViolations(organizationId: string, claimIds: string[]) {
        return this.violations.filter((v) => claimIds.includes(v.claimId) && this.orgOf(v) === organizationId).map(({ claimId, side, signature }) => ({ claimId, side, signature }));
    }
    private orgOf(row: { claimId: string; organizationId?: string }) {
        return row.organizationId ?? this.claims.get(row.claimId)?.organizationId;
    }
    async hardExpiryOf(organizationId: string, claimId: string) {
        const c = this.claims.get(claimId);
        return c && c.organizationId === organizationId ? c.hardExpiresAt : undefined;
    }
}

/** An environment whose claims land in the in-memory claim rows (the hub's job in production). */
export function recordingEnvironment(env: EnvironmentRuntime, claims: InMemoryRunClaims): EnvironmentRuntime {
    return {
        acquire: async (req, opts) => {
            const r = await (opts ? env.acquire(req, opts) : env.acquire(req));
            if (!isBlocked(r) && req.runId && req.ref.side !== 'setup') {
                await claims.record({ claimId: r.claimId, cellId: r.cellId, runId: req.runId, organizationId: req.organizationId, side: req.ref.side, hardExpiresAt: r.hardExpiresAt });
            }
            return r;
        },
        probe: (c, p, s) => env.probe(c, p, s),
        exec: (c, r) => env.exec(c, r),
        reset: (c, imageId, round) => env.reset(c, imageId, round),
        ...(env.snapshotRound ? { snapshotRound: (c, stepId) => env.snapshotRound!(c, stepId) } : {}),
        release: async (c) => {
            await env.release(c);
            await claims.markReleased(c);
        },
        ...(env.bake ? { bake: (r) => env.bake!(r) } : {}),
        ...(env.progress ? { progress: (r) => env.progress!(r) } : {}),
    };
}

/** Wires a Run with no database, no broker and no LLM: for unit tests and the local demo. */
export function inMemoryRunDeps(opts: { env?: EnvironmentRuntime; turns?: RecordedTurn[]; maxTokensPerRun?: number; canaries?: CanaryVault } = {}) {
    const logged: RunLogEvent[] = [];
    const claims = new InMemoryRunClaims();
    const env = recordingEnvironment(opts.env ?? new FakeEnvironmentRuntime(SCENARIOS, () => new Date()), claims);
    const metrics = new RuntimeMetrics();
    const llm = new RecordedLlmGateway(opts.turns ?? (shopTurns as RecordedTurn[]), { maxTokensPerRun: opts.maxTokensPerRun ?? 50_000, metrics });
    const canaries = opts.canaries ?? new HmacCanaryVault();
    // Every prompt is checked for the Run's canaries before it is sent (ADR-043).
    const guarded = new CanaryGuardedLlmGateway(llm, canaries);
    const projection = new InMemoryRunProjectionStore();
    const stream = new InMemoryRunStreamStore();
    const published: RuntimePublishRequested[] = [];
    const deps: RunDeps = {
        step: (_name, fn) => fn(),
        env,
        agent: new RuntimeAgent(guarded, env),
        intent: new IntentClassifier(guarded, { rethrow: isCanaryLeak }),
        intentAuthor: new IntentAuthor(guarded, { rethrow: isCanaryLeak }),
        canaries,
        projection,
        events: stream,
        publisher: { request: async (m) => void published.push(m) },
        claims,
        metrics,
        now: () => new Date(),
        log: { info: (e) => void logged.push(e), warn: (e) => void logged.push({ ...e, level: 'warn' }) },
    };
    return { deps, projection, stream, published, claims, env, llm, canaries, logged };
}
