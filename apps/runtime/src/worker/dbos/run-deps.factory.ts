import { readFileSync } from 'fs';

import type { Claim, EnvironmentRuntime } from '@libs/runtime/environment';
import type { RepoRef } from '@libs/runtime/protocol';
import type { RunProjectionStore, RuntimeRunRequested } from '@libs/runtime/run';
import type { RuntimeMetrics } from '@libs/runtime/telemetry';

import type { EvidenceStore } from '../../shared/evidence/file-evidence-store';
import type { PhysicalAdmissionTicket } from '../../shared/admission/admission-contract';
import type { EvidenceUploads } from '../run/run-evidence';
import { LlmGateway, RecordedTurn } from '../agent/llm-gateway';
import { CanaryGuardedRunPlanClient, type RunPlanClient } from '../agent/http-run-plan';
import { RuntimeAgent } from '../agent/runtime-agent';
import { CanaryGuardedLlmGateway, CanaryVault, HmacCanaryVault, isCanaryLeak } from '../canary/canary';
import shopTurns from '../agent/fixtures/shop-orders.json';
import { HubClient, HubEnvironmentClient } from '../env/hub-environment-runtime';
import { IntentClassifier } from '../intent/intent-classifier';
import { ClaimLeaseKeeper, type LeaseEvent, type LeaseKeeperOptions } from '../run/lease-keeper';
import type { ClaimReleaser, PublishRequester, RunClaims, RunDeps, RunEventSink, RunLog } from '../run/ports';
import { type SecretOpener, setupTokenBinding } from '../secrets/sealed-tokens';

export const RUN_DEPS_FACTORY = Symbol('RUN_DEPS_FACTORY');

export interface RunDepsFactory {
    forRun(req: RuntimeRunRequested, ticket?: PhysicalAdmissionTicket): Omit<RunDeps, 'step'>;
    forStop(run: { runId: string; correlationId: string; organizationId: string }): Omit<RunDeps, 'step'>;
    /** The control plane's reaper: claims past their hard expiry (§11 reaper.terminated). */
    reap(now: Date, metrics: RuntimeMetrics): Promise<number>;
}

export function loadRecordedTurns(path?: string): RecordedTurn[] {
    return path ? JSON.parse(readFileSync(path, 'utf8')) : (shopTurns as RecordedTurn[]);
}

/** Claims past their hard expiry that nobody released (input of the reaper). */
export interface HardExpiredClaims {
    hardExpired(now: Date): Promise<Array<{ claimId: string; cellId: string; orgId: string; runId: string | null }>>;
}

export interface RunDependenciesOptions {
    /** The EnvironmentRuntime of a Run or a setup: the hub client in production, a fake in tests. */
    environment: (ctx: EnvironmentContext) => EnvironmentRuntime;
    /** Explicit development/test fake path only; production environments must implement claim renewal. */
    allowUnrenewedClaims?: boolean;
    projection: RunProjectionStore;
    claims: RunClaims & HardExpiredClaims;
    releaser: ClaimReleaser;
    publisher: PublishRequester;
    llm: LlmGateway;
    /** The product's test planner (ADR-069); absent (recorded fixtures), the plan is the 2-turn loop over `llm`. */
    planner?: RunPlanClient;
    metrics: RuntimeMetrics;
    events: RunEventSink;
    /** Keys the canary derivation (never a constant: the VM must not be able to compute a canary). */
    canaryKey: Buffer;
    evidence?: Pick<EvidenceStore, 'put'> & Partial<Pick<EvidenceStore, 'get' | 'takeUpload'>>;
    /** Where cells upload a round's artifacts with grants (RUNTIME_EVIDENCE_UPLOAD_URL + the signing secret). */
    evidenceUploads?: EvidenceUploads;
    onReleaseFailed?: (claimId: string, e: Error) => void;
    /** How a Run's claims are renewed while it works (defaults: a third of the lease, a minute after a miss). */
    leaseRenewal?: Pick<LeaseKeeperOptions, 'everyMs' | 'retryMs' | 'timers'>;
    /** What the renewals saw, for the worker's log (ids only). */
    onLeaseEvent?: (runId: string, e: LeaseEvent) => void;
    /** Each Run's phase lines and its run.finished line (ids and numbers only). */
    log?: RunLog;
}

/** What an environment client is built for: one Run, or one setup (no Run). */
export interface EnvironmentContext {
    admissionTicket?: PhysicalAdmissionTicket;
    correlationId: string;
    organizationId: string;
    runId?: string;
    fullName: string;
    /** Sealed. */
    sealedRepoToken: string;
    /** Sealed: the PR side's own download token (each claim revokes the one it fetched with). */
    sealedPrRepoToken?: string;
    tokenBinding: string;
    imageId: string;
    expose: Claim['manifest']['expose'];
}

/**
 * The cell of the environment's last setup, which holds its warm pool; only
 * from a record of the same org.
 */
export const poolCellOf =
    (setups: { get(environmentId: string): Promise<{ organizationId: string; cellId?: string; buildCellId?: string } | null> }) =>
    async (organizationId: string, environmentId: string) => {
        const rec = await setups.get(environmentId);
        // The cell of the active setup (its bake, its pool), else the one the last boot built on (its state).
        return rec?.organizationId === organizationId ? (rec.cellId ?? rec.buildCellId) : undefined;
    };

/** The hub-backed environment of a Run or setup (production). */
export function hubEnvironments(
    hub: HubClient,
    secrets: SecretOpener,
    git: { provider: RepoRef['provider']; apiBase: string },
    preferCell?: (organizationId: string, environmentId: string) => Promise<string | undefined>,
) {
    return (ctx: EnvironmentContext): EnvironmentRuntime =>
        new HubEnvironmentClient(hub, secrets, {
            correlationId: ctx.correlationId,
            organizationId: ctx.organizationId,
            ...(ctx.runId ? { runId: ctx.runId } : {}),
            repo: { provider: git.provider, fullName: ctx.fullName, apiBase: git.apiBase },
            sealedRepoToken: ctx.sealedRepoToken,
            ...(ctx.sealedPrRepoToken ? { sealedPrRepoToken: ctx.sealedPrRepoToken } : {}),
            tokenBinding: ctx.tokenBinding,
            imageId: ctx.imageId,
            expose: ctx.expose,
            ...(ctx.admissionTicket ? { admissionTicket: ctx.admissionTicket } : {}),
            ...(preferCell ? { preferCell } : {}),
        });
}

/** The canary key, derived from the sealing key (one secret to manage, separate purposes). */
export { canaryKeyFrom } from '@libs/runtime/canary';

export class RunDependenciesFactory implements RunDepsFactory {
    private readonly canaries: CanaryVault;

    constructor(private readonly deps: RunDependenciesOptions) {
        this.canaries = new HmacCanaryVault(deps.canaryKey);
    }

    private base(env: EnvironmentRuntime): Omit<RunDeps, 'step'> {
        // Every prompt is checked for the Run's canaries before it leaves (ADR-043).
        const llm = new CanaryGuardedLlmGateway(this.deps.llm, this.canaries);
        return {
            env,
            agent: new RuntimeAgent(llm, env, this.deps.planner ? new CanaryGuardedRunPlanClient(this.deps.planner, this.canaries) : undefined),
            intent: new IntentClassifier(llm, { rethrow: isCanaryLeak }),
            canaries: this.canaries,
            projection: this.deps.projection,
            events: this.deps.events,
            publisher: this.deps.publisher,
            claims: this.deps.claims,
            metrics: this.deps.metrics,
            now: () => new Date(),
            ...(this.deps.evidence ? { evidence: this.deps.evidence } : {}),
            ...(this.deps.evidenceUploads ? { evidenceUploads: this.deps.evidenceUploads } : {}),
            ...(this.deps.onReleaseFailed ? { onReleaseFailed: this.deps.onReleaseFailed } : {}),
            ...(this.deps.log ? { log: this.deps.log } : {}),
        };
    }

    forRun(req: RuntimeRunRequested, ticket?: PhysicalAdmissionTicket) {
        const env = this.deps.environment({
            ...(ticket ? { admissionTicket: ticket } : {}),
            correlationId: req.correlationId,
            organizationId: req.organizationId,
            runId: req.runId,
            fullName: req.repository.fullName ?? req.repository.name,
            sealedRepoToken: req.repoToken,
            ...(req.prRepoToken ? { sealedPrRepoToken: req.prRepoToken } : {}),
            tokenBinding: req.runId,
            imageId: req.environment.imageId,
            expose: req.environment.expose,
        });
        this.requireRenewal(env);
        const renew = env.renew?.bind(env);
        return {
            ...this.base(env),
            // Only an environment that can renew gets a keeper; the claims otherwise keep their acquire's lease.
            ...(renew
                ? {
                      leases: new ClaimLeaseKeeper((claimId) => renew(claimId, 'runtime'), {
                          ...this.deps.leaseRenewal,
                          onEvent: (e) => this.deps.onLeaseEvent?.(req.runId, e),
                      }),
                  }
                : {}),
        };
    }

    /** A stopped Run only releases and publishes: its environment never acquires (no token). */
    forStop(run: { runId: string; correlationId: string; organizationId: string }) {
        return this.base(
            this.deps.environment({
                correlationId: run.correlationId,
                organizationId: run.organizationId,
                runId: run.runId,
                fullName: 'stopped/run',
                sealedRepoToken: '',
                tokenBinding: run.runId,
                imageId: 'latest',
                expose: [],
            }),
        );
    }

    /** The environment of a setup (no Run): same hub client and Git config as a Run's. */
    envForSetup(input: { correlationId: string; organizationId: string; setupKey: string; fullName: string; sealedRepoToken: string; imageId: string; expose: Claim['manifest']['expose']; admissionTicket?: PhysicalAdmissionTicket }): EnvironmentRuntime {
        const env = this.deps.environment({
            ...(input.admissionTicket ? { admissionTicket: input.admissionTicket } : {}),
            correlationId: input.correlationId,
            organizationId: input.organizationId,
            fullName: input.fullName,
            sealedRepoToken: input.sealedRepoToken,
            tokenBinding: setupTokenBinding(input.setupKey),
            imageId: input.imageId,
            expose: input.expose,
        });
        this.requireRenewal(env);
        return env;
    }

    private requireRenewal(env: EnvironmentRuntime): void {
        if (!this.deps.allowUnrenewedClaims && typeof env.renew !== 'function') throw new Error('production environments require claim renewal');
    }

    /** The environment of a dev's interactive session (consumer mcp, no Run): the same hub client. */
    envForSession(input: EnvironmentContext): EnvironmentRuntime {
        return this.deps.environment({ ...input, runId: undefined });
    }

    async reap(now: Date, metrics: RuntimeMetrics) {
        const expired = await this.deps.claims.hardExpired(now);
        let released = 0;
        for (const c of expired) {
            try {
                await this.deps.releaser.release({ claimId: c.claimId, organizationId: c.orgId, runId: c.runId });
                released++;
                metrics.recordReaperTerminated({ cellId: c.cellId, orgId: c.orgId, reason: 'hard_expired' });
            } catch (e) {
                // Left for the next tick: the claim stays open until the hub records the release.
                this.deps.onReleaseFailed?.(c.claimId, e as Error);
            }
        }
        return released;
    }
}

/** @deprecated the old name of RunDependenciesFactory. */
export const DefaultRunDepsFactory = RunDependenciesFactory;
