import { EnvironmentRuntime, FakeEnvironmentRuntime, isBlocked } from '@libs/runtime/environment';
import type { RuntimePublishRequested } from '@libs/runtime/run';
import { InMemoryRunProjectionStore, InMemoryRunStreamStore } from '@libs/runtime/run/testing';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { SCENARIOS } from '../../fake-cell/scenarios';
import { RecordedLlmGateway, RecordedTurn } from '../agent/llm-gateway';
import { RuntimeAgent } from '../agent/runtime-agent';
import { CanaryGuardedLlmGateway, CanaryVault, HmacCanaryVault, isCanaryLeak } from '../canary/canary';
import { IntentClassifier } from '../intent/intent-classifier';
import shopTurns from '../agent/fixtures/shop-orders.json';
import type { RunClaims, RunDeps, RunLogEvent } from './ports';

/**
 * The hub's claim rows, in memory: the environment below records a claim on
 * acquire and releases it on release, like the hub does in runtime_claims.
 */
export class InMemoryRunClaims implements RunClaims {
    readonly claims = new Map<string, { claimId: string; cellId: string; runId: string; organizationId: string; side: string; released: boolean; hardExpiresAt: string }>();
    readonly egress: { claimId: string; host: string; port: number; phase: string }[] = [];
    readonly violations: { claimId: string; side: string; signature: string }[] = [];

    async record(c: { claimId: string; cellId: string; runId: string; organizationId: string; side: 'base' | 'pr'; hardExpiresAt: string }) {
        if (!this.claims.has(c.claimId)) this.claims.set(c.claimId, { ...c, released: false });
    }
    async forRun(runId: string) {
        return [...this.claims.values()].filter((c) => c.runId === runId && !c.released);
    }
    async markReleased(claimId: string) {
        const c = this.claims.get(claimId);
        if (c) c.released = true;
    }
    async egressBlocked(claimIds: string[]) {
        return this.egress.filter((e) => claimIds.includes(e.claimId));
    }
    async securityViolations(claimIds: string[]) {
        return this.violations.filter((v) => claimIds.includes(v.claimId));
    }
}

/** @deprecated the old name of InMemoryRunClaims. */
export const InMemoryClaimLedger = InMemoryRunClaims;

/** An environment whose claims land in the in-memory claim rows (the hub's job in production). */
export function recordingEnvironment(env: EnvironmentRuntime, claims: InMemoryRunClaims): EnvironmentRuntime {
    return {
        acquire: async (req) => {
            const r = await env.acquire(req);
            if (!isBlocked(r) && req.runId && req.ref.side !== 'setup') {
                await claims.record({ claimId: r.claimId, cellId: r.cellId, runId: req.runId, organizationId: req.organizationId, side: req.ref.side, hardExpiresAt: r.hardExpiresAt });
            }
            return r;
        },
        probe: (c, p, s) => env.probe(c, p, s),
        exec: (c, r) => env.exec(c, r),
        reset: (c, imageId) => env.reset(c, imageId),
        release: async (c) => {
            await env.release(c);
            await claims.markReleased(c);
        },
        ...(env.bake ? { bake: (r) => env.bake!(r) } : {}),
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
