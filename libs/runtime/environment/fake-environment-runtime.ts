import { routeShapeOf } from '@libs/runtime/entry-points/coverage';
import type { Probe, ProbeResult } from '@libs/runtime/probe';
import type { EvidenceRequest } from '@libs/runtime/protocol';

import {
    AcquireRequest,
    Blocked,
    Claim,
    EnvError,
    EnvironmentRuntime,
    ExecRequest,
    ProbeOutcome,
    HARD_EXPIRY_MINUTES,
    LEASE_TTL_MINUTES,
    StepResult,
} from './environment-runtime';

export interface FakeEnvironment {
    imageId: string;
    expose: Claim['manifest']['expose'];
    blockers?: Blocked['blockers'];
    /** Probe answers by side; a function lets a test vary by round. */
    probes?: Record<string, Partial<Record<'base' | 'pr', (round: number) => Partial<ProbeOutcome>>>>;
    exec?: (command: string) => Partial<StepResult>;
}

/** In-memory driver for tests: no cloud, no network, deterministic clock. */
export class FakeEnvironmentRuntime implements EnvironmentRuntime {
    private readonly claims = new Map<string, { req: AcquireRequest; claim: Claim; rounds: number; released: boolean }>();
    private readonly byKey = new Map<string, string>();
    private seq = 0;
    readonly resets: string[] = [];

    constructor(
        private readonly envs: Record<string, FakeEnvironment>,
        private readonly now: () => Date = () => new Date('2026-10-29T12:00:00Z'),
    ) {}

    async acquire(req: AcquireRequest): Promise<Claim | Blocked> {
        const existing = this.byKey.get(req.idempotencyKey);
        if (existing) return this.claims.get(existing)!.claim;

        const env = this.envs[req.environmentId];
        if (!env) {
            return { status: 'blocked', blockers: [{ kind: 'platform', signature: 'unknown-environment', message: req.environmentId }] };
        }
        if (env.blockers?.length) return { status: 'blocked', blockers: env.blockers };
        if (req.imageId && req.imageId !== env.imageId) {
            return { status: 'blocked', blockers: [{ kind: 'recipe_outdated', signature: 'image-mismatch', message: req.imageId }] };
        }

        const at = this.now().getTime();
        const claimId = `claim-${++this.seq}`;
        const claim: Claim = {
            claimId,
            cellId: 'fake-cell',
            cellOwner: 'kodus',
            leaseExpiresAt: new Date(at + LEASE_TTL_MINUTES[req.consumer] * 60_000).toISOString(),
            hardExpiresAt: new Date(at + HARD_EXPIRY_MINUTES[req.consumer] * 60_000).toISOString(),
            observer: { id: `${claimId}-observer`, state: 'ready' },
            manifest: { services: env.expose.map((e) => ({ name: e.service, health: 'ok' })), expose: env.expose, imageId: env.imageId, seedSha: 'seed-1' },
        };
        this.claims.set(claimId, { req, claim, rounds: 0, released: false });
        this.byKey.set(req.idempotencyKey, claimId);
        return claim;
    }

    private live(claimId: string) {
        const c = this.claims.get(claimId);
        if (!c || c.released || this.now().getTime() > Date.parse(c.claim.hardExpiresAt)) return undefined;
        return c;
    }

    /** Captures nothing: a cell without the evidence features, so every block reads "not captured". */
    async probe(claimId: string, probe: Probe, stepId: string, _evidence?: EvidenceRequest): Promise<ProbeOutcome | EnvError> {
        const c = this.live(claimId);
        if (!c) return { code: 'lease_expired' };
        if (probe.spec.kind === 'shell') {
            throw new Error('shell probes run inside the VM through exec, never on the observer');
        }
        const side = c.req.ref.side === 'pr' ? 'pr' : 'base';
        const answer = this.envs[c.req.environmentId].probes?.[probe.id]?.[side]?.(++c.rounds) ?? {};
        // Like the cell's observer: the log holds what was sent, by method and route.
        const sent =
            probe.spec.kind === 'http'
                ? [{ method: probe.spec.method, route: routeShapeOf(probe.spec.path), status: answer.http?.status ?? 200 }]
                : [];
        return {
            stepId,
            executor: 'observer',
            imageId: c.claim.manifest.imageId,
            requests: sent,
            durationMs: 10,
            transport: 'ok',
            vmHealth: 'ok',
            ...answer,
        };
    }

    async exec(claimId: string, req: ExecRequest): Promise<StepResult | EnvError> {
        const c = this.live(claimId);
        if (!c) return { code: 'lease_expired' };
        const out = this.envs[c.req.environmentId].exec?.(req.command) ?? {};
        return { stepId: req.stepId, exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 5, transport: 'ok', ...out };
    }

    async reset(claimId: string): Promise<void | EnvError> {
        if (!this.live(claimId)) return { code: 'lease_expired' };
        this.resets.push(claimId);
    }

    async release(claimId: string): Promise<void> {
        const c = this.claims.get(claimId);
        if (c) c.released = true;
    }
}
