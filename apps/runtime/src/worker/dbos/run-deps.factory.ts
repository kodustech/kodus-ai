import type { IsolationMinimum } from '@libs/runtime/contracts/isolation';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';

import type { PastPlans } from '../run/plan-reuse';
import type { KeptCheckResults, StabilityHistory } from '../run/ports';

import type { Claim, EnvironmentHealthInput, EnvironmentRuntime } from '@libs/runtime/environment';
import { environmentHealthOf } from '@libs/runtime/environment';
import type { RepoRef } from '@libs/runtime/protocol';
import { type ClaimWorkspace, memberPullRequestAliasOf, type RunProjectionStore, runClaimWorkspace, type RuntimeRunRequested } from '@libs/runtime/run';
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
import { resetTimeoutMs } from '../env/ready-check';
import { IntentAuthor } from '../intent/intent-author';
import { IntentClassifier } from '../intent/intent-classifier';
import { ClaimLeaseKeeper, type LeaseEvent, type LeaseKeeperOptions } from '../run/lease-keeper';
import type { ClaimReleaser, PublishRequester, RunClaims, RunDeps, RunEventSink, RunLog } from '../run/ports';
import { type SecretOpener, setupTokenBinding } from '../secrets/sealed-tokens';
import type { SuiteEnvironmentContext } from '../suite/suite-service';
import { type SuiteEnvironment, suiteEnvironment } from '../suite/suite-environment';

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
    /** Earlier Runs' accepted plans, for a Run of the same head (run/plan-reuse.ts). */
    pastPlans?: PastPlans;
    /** The probes' versioned stability history (runtime_stability, ADR-050); absent: every probe starts with the table's default. */
    stability?: StabilityHistory;
    /** Each Run's kept-check outcomes (runtime_kept_check_results); absent: they stay on the Run only. */
    keptCheckResults?: KeptCheckResults;
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
    /** RunDeps.roundSnapshots (RUNTIME_ROUND_SNAPSHOTS). */
    roundSnapshots?: boolean;
    /** RunDeps.capacityWaitMaxMs (RUNTIME_CAPACITY_WAIT_MAX_MS). */
    capacityWaitMaxMs?: number;
    /** RunDeps.queueTimeoutMs (RUNTIME_QUEUE_TIMEOUT_MS). */
    queueTimeoutMs?: number;
    /** RunDeps.exercisedLinesThresholdPercent (RUNTIME_EXERCISED_LINES_THRESHOLD_PERCENT). */
    exercisedLinesThresholdPercent?: number;
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
    /** The repositories of a multi-repository environment, tokens sealed; absent for one repository. */
    workspace?: ClaimWorkspace;
    /** A Run whose PR is in a member repository: the alias its commands run on (exec.repository). */
    execRepository?: string;
    /** How long a round's machine.reset may take: the recipe's health wait, never under the default. */
    resetTimeoutMs?: number;
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
    setups?: { get(environmentId: string): Promise<EnvironmentHealthInput & { organizationId: string } | null> },
    evidenceReads?: EvidenceUploads,
    isolationMinimum?: IsolationMinimum,
) {
    const health = setups ? healthOfSetup(setups) : undefined;
    return (ctx: EnvironmentContext): EnvironmentRuntime =>
        new HubEnvironmentClient(hub, secrets, {
            ...(isolationMinimum ? { isolationMinimum } : {}),
            correlationId: ctx.correlationId,
            organizationId: ctx.organizationId,
            ...(ctx.runId ? { runId: ctx.runId } : {}),
            repo: { provider: git.provider, fullName: ctx.fullName, apiBase: git.apiBase },
            sealedRepoToken: ctx.sealedRepoToken,
            ...(ctx.sealedPrRepoToken ? { sealedPrRepoToken: ctx.sealedPrRepoToken } : {}),
            tokenBinding: ctx.tokenBinding,
            imageId: ctx.imageId,
            expose: ctx.expose,
            ...(ctx.workspace ? { workspace: ctx.workspace } : {}),
            ...(ctx.resetTimeoutMs ? { resetTimeoutMs: ctx.resetTimeoutMs } : {}),
            ...(ctx.execRepository ? { execRepository: ctx.execRepository } : {}),
            ...(ctx.admissionTicket ? { admissionTicket: ctx.admissionTicket } : {}),
            ...(preferCell ? { preferCell } : {}),
            ...(health ? { health } : {}),
            ...(evidenceReads ? { evidenceReads } : {}),
        });
}

/** EnvironmentRuntime.status from the environment's setup record, only from a record of the same org. */
export const healthOfSetup =
    (setups: { get(environmentId: string): Promise<EnvironmentHealthInput & { organizationId: string } | null> }) =>
    async (organizationId: string, environmentId: string) => {
        const rec = await setups.get(environmentId);
        return environmentHealthOf(rec?.organizationId === organizationId ? rec : { environmentId }, new Date());
    };

/** The canary key, derived from the sealing key (one secret to manage, separate purposes). */
export { canaryKeyFrom } from '@libs/runtime/canary';

/**
 * The worker's port to claim.exercised: the cell's counts, or undefined when the cell does not name
 * exercisedLines or the ask failed (the Run reads it as not measured, never as a blocker).
 */
function exercisedPort(env: EnvironmentRuntime): NonNullable<RunDeps['requestExercised']> {
    return async (claim, request) => {
        const r = await env.exercisedLines!(claim.claimId, randomUUID(), request);
        return r && !('code' in r) ? r : undefined;
    };
}

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
            intentAuthor: new IntentAuthor(llm, { rethrow: isCanaryLeak }),
            canaries: this.canaries,
            projection: this.deps.projection,
            events: this.deps.events,
            publisher: this.deps.publisher,
            claims: this.deps.claims,
            metrics: this.deps.metrics,
            now: () => new Date(),
            ...(env.exercisedLines ? { requestExercised: exercisedPort(env) } : {}),
            ...(this.deps.evidence ? { evidence: this.deps.evidence } : {}),
            ...(this.deps.evidenceUploads ? { evidenceUploads: this.deps.evidenceUploads } : {}),
            ...(this.deps.onReleaseFailed ? { onReleaseFailed: this.deps.onReleaseFailed } : {}),
            ...(this.deps.log ? { log: this.deps.log } : {}),
            ...(this.deps.roundSnapshots ? { roundSnapshots: true } : {}),
            ...(this.deps.capacityWaitMaxMs !== undefined ? { capacityWaitMaxMs: this.deps.capacityWaitMaxMs } : {}),
            ...(this.deps.queueTimeoutMs !== undefined ? { queueTimeoutMs: this.deps.queueTimeoutMs } : {}),
            ...(this.deps.exercisedLinesThresholdPercent !== undefined ? { exercisedLinesThresholdPercent: this.deps.exercisedLinesThresholdPercent } : {}),
            ...(this.deps.pastPlans ? { pastPlans: this.deps.pastPlans } : {}),
            ...(this.deps.stability ? { stability: this.deps.stability } : {}),
            ...(this.deps.keptCheckResults ? { keptCheckResults: this.deps.keptCheckResults } : {}),
        };
    }

    forRun(req: RuntimeRunRequested, ticket?: PhysicalAdmissionTicket) {
        // A multi-repository Run's claims are of the primary, which is not the PR's repository when the PR is in another one.
        const workspace = runClaimWorkspace(req);
        const execRepository = memberPullRequestAliasOf(req);
        const env = this.deps.environment({
            ...(ticket ? { admissionTicket: ticket } : {}),
            correlationId: req.correlationId,
            organizationId: req.organizationId,
            runId: req.runId,
            fullName: workspace?.primary.fullName ?? req.repository.fullName ?? req.repository.name,
            sealedRepoToken: req.repoToken,
            ...(req.prRepoToken ? { sealedPrRepoToken: req.prRepoToken } : {}),
            tokenBinding: req.runId,
            imageId: req.environment.imageId,
            expose: req.environment.expose,
            ...(workspace ? { workspace } : {}),
            ...(execRepository ? { execRepository } : {}),
            resetTimeoutMs: resetTimeoutMs(req.environment.ready),
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
    envForSetup(input: { correlationId: string; organizationId: string; setupKey: string; fullName: string; sealedRepoToken: string; imageId: string; expose: Claim['manifest']['expose']; admissionTicket?: PhysicalAdmissionTicket; workspace?: ClaimWorkspace }): EnvironmentRuntime {
        const env = this.deps.environment({
            ...(input.admissionTicket ? { admissionTicket: input.admissionTicket } : {}),
            correlationId: input.correlationId,
            organizationId: input.organizationId,
            fullName: input.fullName,
            sealedRepoToken: input.sealedRepoToken,
            tokenBinding: setupTokenBinding(input.setupKey),
            imageId: input.imageId,
            expose: input.expose,
            ...(input.workspace ? { workspace: input.workspace } : {}),
        });
        this.requireRenewal(env);
        return env;
    }

    /**
     * The environment of a suite run (no Run): the claims of its shards, the fresh host and the main host, each acquired by a
     * client with a download token of its own (the cell revokes a token once it fetched with it) bound to the command's key,
     * and each kept leased while the engine holds it.
     */
    envForSuite(input: SuiteEnvironmentContext): SuiteEnvironment {
        return suiteEnvironment(
            (sealedRepoToken) => {
                const env = this.deps.environment({
                    correlationId: input.correlationId,
                    organizationId: input.organizationId,
                    fullName: input.fullName,
                    sealedRepoToken,
                    tokenBinding: input.key,
                    imageId: input.imageId,
                    expose: input.expose,
                });
                this.requireRenewal(env);
                return env;
            },
            input.tokens,
            { ...this.deps.leaseRenewal, onEvent: (e) => this.deps.onLeaseEvent?.(input.suiteRunId, e) },
        );
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
