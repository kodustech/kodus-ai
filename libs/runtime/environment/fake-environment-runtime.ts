import { createHash } from 'node:crypto';

import { routeShapeOf } from '@libs/runtime/entry-points/coverage';
import type { Probe } from '@libs/runtime/probe';
import type { EvidenceRequest } from '@libs/runtime/protocol';
import { type CellIsolation, isolationSatisfies } from '@libs/runtime/contracts/isolation';

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
import { isolationUnavailable } from './isolation-blocker';

export interface FakeEnvironment {
    imageId: string;
    expose: Claim['manifest']['expose'];
    blockers?: Blocked['blockers'];
    /** Probe answers by side; a function lets a test vary by round. */
    probes?: Record<string, Partial<Record<'base' | 'pr', (round: number) => Partial<ProbeOutcome>>>>;
    exec?: (command: string) => Partial<StepResult>;
    /** What the fake cell runs claims under; absent: 'sandboxed-container' (gVisor). */
    cellIsolation?: CellIsolation;
}

/** In-memory driver for tests: no cloud, no network, deterministic clock. */
export class FakeEnvironmentRuntime implements EnvironmentRuntime {
    private readonly claims = new Map<string, { req: AcquireRequest; claim: Claim; rounds: number; released: boolean }>();
    private readonly byKey = new Map<string, string>();
    private seq = 0;
    readonly resets: string[] = [];
    /** The round snapshot each reset named (undefined: a compose reset), in the order of resets. */
    readonly resetRounds: Array<string | undefined> = [];
    /** The round snapshots taken, by claim. */
    readonly rounds = new Map<string, string>();

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
        if (!isolationSatisfies(env.cellIsolation ?? 'sandboxed-container', req.isolation)) return isolationUnavailable(req.isolation ?? 'any', 'the fake cell');
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

    async reset(claimId: string, _imageId?: string, roundSnapshotId?: string): Promise<void | EnvError> {
        if (!this.live(claimId)) return { code: 'lease_expired' };
        this.resets.push(claimId);
        this.resetRounds.push(roundSnapshotId);
    }

    /** A round snapshot of a live claim: one id per claim, as a cell that keeps snapshots answers. */
    async snapshotRound(claimId: string, _stepId: string): Promise<{ id: string; ms: number } | EnvError> {
        if (!this.live(claimId)) return { code: 'lease_expired' };
        const id = `ksn-${createHash('sha256').update(claimId).digest('hex').slice(0, 32)}`;
        this.rounds.set(claimId, id);
        return { id, ms: 1 };
    }

    async release(claimId: string): Promise<void> {
        const c = this.claims.get(claimId);
        if (c) c.released = true;
        // As a cell does: the claim's round snapshot goes with it.
        this.rounds.delete(claimId);
    }
}
