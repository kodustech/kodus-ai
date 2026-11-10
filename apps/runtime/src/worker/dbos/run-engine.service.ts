import { DBOS } from '@dbos-inc/dbos-sdk';
import { createHash } from 'crypto';
import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit, Optional } from '@nestjs/common';

import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';

import { isForkApprovalRequired, isTerminal, RunProjectionStore, RuntimeRunProjection, RuntimeRunRequested } from '@libs/runtime/run';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { COMMAND_STORE, RUNTIME_CONFIG, WorkerConfig } from '../../shared/config';
import type { DistributedLocks } from '../../shared/locks';
import type { CommandStore } from '../../shared/pg-command-store';
import { ADMISSION_WAIT_MS, type AdmissionReason, type AdmissionRecord, type AdmissionRef } from '../../shared/admission-contract';
import { awaitForkApproval, finalizeStoppedRun, QUEUE_TIMEOUT_MS, RUN_TIMEOUT_MS, RunOptions, runRuntimeRun } from '../run/run-orchestrator';
import type { ForkApprovalMessage, RunDeps } from '../run/ports';
import { ENVIRONMENT_SETUP_SERVICE, EnvironmentSetupService } from '../setup/environment-setup.service';
import { RUN_DEPS_FACTORY, RunDepsFactory } from './run-deps.factory';
import { ADMISSION_COORDINATOR, AdmissionCoordinator, admissionRefOf } from './admission-coordinator';

// The Run as a DBOS Transact workflow (ADR-046): workflowID = runId makes the
// start idempotent, the queue is partitioned by org for fairness, and every
// phase is a checkpointed step. The Runtime database holds the DBOS tables.
//
// A fork PR first runs its approval gate, a workflow off the queue: waiting
// days for a maintainer never holds a queue slot. Once approved, the gate
// enqueues the Run itself (workflowID `${runId}:run`) and waits for it.

export const RUN_QUEUE = 'runtime-runs';
export const RUN_WORKFLOW = 'runtimeRun';
export const FORK_GATE_WORKFLOW = 'runtimeForkGate';
export const STOP_WORKFLOW = 'runtimeRunStop';
/** Environment setups: their own queue, one setup at a time per org (fair, and a setup never takes a Run's slot). */
export const SETUP_QUEUE = 'runtime-setups';
export const SETUP_WORKFLOW = 'runtimeEnvironmentSetup';
export const ADMISSION_QUEUE = 'runtime-admissions';
export const EXECUTION_QUEUE = 'runtime-executions';
export const ADMISSION_WORKFLOW = 'runtimeAdmission';
export const ADMISSION_FINALIZE_QUEUE = 'runtime-admission-finalizers';
export const setupWorkflowId = (key: string) => `setup:${key}`;
/** The queued Run a fork's gate starts once approved. */
export const approvedRunWorkflowId = (runId: string) => `${runId}:run`;
const runIdOfWorkflow = (workflowId: string) => workflowId.replace(/:run$/, '');
export const admissionAttemptWorkflowId = (ref: AdmissionRef, generation: number, ownerEpoch: number, repairBucket?: number) =>
    `admission:${createHash('sha256').update(JSON.stringify([ref.organizationId, ref.kind, ref.key])).digest('hex')}:${generation}:${ownerEpoch}${repairBucket === undefined ? '' : `:repair:${repairBucket}`}`;

interface SetupWorkflowOptions {
    admissionRef?: AdmissionRef;
    admissionBlocker?: { kind: 'resources' | 'platform'; signature: string; message: string };
}
const runRef = (req: Pick<RuntimeRunRequested, 'organizationId' | 'runId'>): AdmissionRef => ({ organizationId: req.organizationId, kind: 'run', key: req.runId });
const terminalAdmission = (reason: AdmissionReason): StopState => reason === 'deadline' || reason === 'attempt_limit' ? 'timed_out' : reason === 'cancelled' ? 'cancelled' : 'errored';
const admissionMessage = (reason: string) => `Runtime admission: ${reason}; Run again`;
const stoppedRequest = (req: RuntimeRunRequested): StoppedRun => ({ runId: req.runId, organizationId: req.organizationId, attempt: req.attempt, correlationId: req.correlationId, headSha: req.pullRequest.headSha });
export class AdmissionInputConflictError extends Error {
    readonly code = 'admission_conflict';
    constructor() { super('admission input conflicts with an existing execution'); this.name = 'AdmissionInputConflictError'; }
}

export const APPROVAL_TOPIC = 'fork_approved';
const APPROVAL_WAIT_SECONDS = 7 * 24 * 3_600;
const MAINTENANCE_LOCK = 'runtime-worker/maintenance';
export const RUN_ENGINE_LOCKS = Symbol('RUN_ENGINE_LOCKS');
export const RUN_ENGINE_RETENTION = Symbol('RUN_ENGINE_RETENTION');
const RETENTION_EVERY_MS = 3_600_000;

export type StoppedRun = { runId: string; attempt: number; organizationId: string; correlationId: string; headSha: string };
export type StopState = 'superseded' | 'cancelled' | 'timed_out' | 'errored';

/**
 * The steps that hand the product a publication (the comment, the check, the
 * progress edits) go through the broker: a broker that restarts must not end
 * the Run without its comment (kr-grafana #7: RabbitMQ down at 09:08, the Run
 * errored and the PR kept "running"). The requester's confirm deadline fails
 * the try; DBOS retries it for ~10 min. Publication keys make a retry
 * idempotent (ADR-052). Other steps keep one try: a retried LLM call costs.
 */
export const PUBLISH_STEP_RETRY = { retriesAllowed: true, maxAttempts: 8, intervalSeconds: 5, backoffRate: 2 } as const;
export const isPublishStep = (name: string) => name === 'publish' || name.startsWith('publish:');
const dbosStep: RunDeps['step'] = (name, fn) => DBOS.runStep(fn, isPublishStep(name) ? { name, ...PUBLISH_STEP_RETRY } : { name });
const stoppedRun = (run: RuntimeRunProjection): StoppedRun => ({
    runId: run.runId,
    attempt: run.attempt,
    organizationId: run.organizationId,
    correlationId: run.correlationId,
    headSha: run.headSha,
});

@Injectable()
export class RunEngineService implements OnModuleInit, OnApplicationShutdown {
    private readonly logger = new Logger('RunEngine');
    private runWorkflow!: (req: RuntimeRunRequested, opts: RunOptions) => Promise<unknown>;
    private forkGateWorkflow!: (req: RuntimeRunRequested) => Promise<unknown>;
    private stopWorkflow!: (run: StoppedRun, state: StopState, reason: string) => Promise<unknown>;
    private setupWorkflow?: (cmd: RuntimeEnvironmentSetupRequested, opts?: SetupWorkflowOptions) => Promise<unknown>;
    private admissionWorkflow?: (ref: AdmissionRef, generation: number) => Promise<void>;
    private sweeper?: NodeJS.Timeout;
    private lastRetentionAt = 0;
    launched = false;

    constructor(
        @Inject(RUNTIME_CONFIG) private readonly config: WorkerConfig,
        @Inject(RUN_DEPS_FACTORY) private readonly depsFactory: RunDepsFactory,
        @Inject('RUN_PROJECTION') private readonly projection: RunProjectionStore,
        @Inject(RuntimeMetrics) private readonly metrics: RuntimeMetrics,
        @Inject(COMMAND_STORE) private readonly commands: CommandStore,
        @Inject(RUN_ENGINE_LOCKS) private readonly locks: DistributedLocks,
        @Optional() @Inject(ENVIRONMENT_SETUP_SERVICE) private readonly setup?: Pick<EnvironmentSetupService, 'run'>,
        @Optional() @Inject(RUN_ENGINE_RETENTION) private readonly retention?: () => Promise<number>,
        @Optional() @Inject(ADMISSION_COORDINATOR) private readonly admission?: AdmissionCoordinator,
    ) {}

    async onModuleInit() {
        if (this.config.durableAdmission && !this.admission) throw new Error('durable admission coordinator is required');
        const factory = this.depsFactory;
        const approvals = {
            has: (runId: string, headSha: string) => this.commands.hasForkApproval(runId, headSha),
            wait: (_runId: string) => DBOS.recv<ForkApprovalMessage>(APPROVAL_TOPIC, APPROVAL_WAIT_SECONDS),
        };
        this.runWorkflow = DBOS.registerWorkflow(async (req: RuntimeRunRequested, opts: RunOptions) => this.executeRun(req, opts ?? {}), {
            name: RUN_WORKFLOW,
        });
        this.forkGateWorkflow = DBOS.registerWorkflow(
            async (req: RuntimeRunRequested) => {
                const gate = await awaitForkApproval(req, { ...factory.forRun(req), approvals, step: dbosStep });
                if (!('approved' in gate)) return gate;
                if (this.config.durableAdmission) {
                    const record = await dbosStep('fork:admission-approved', async () => {
                        const transition = await this.admission!.store.approveRun(runRef(req), {
                            repoToken: gate.approved.repoToken,
                            ...(gate.approved.prRepoToken ? { prRepoToken: gate.approved.prRepoToken } : {}),
                            runToken: gate.approved.runToken,
                        }, this.admission!.limits);
                        if (!transition.record) return null;
                        const { payload, ...control } = transition.record;
                        return { ...control, options: payload?.kind === 'run' ? payload.options : undefined };
                    });
                    if (!record || record.state === 'awaiting_approval') throw new Error('fork admission approval could not be persisted');
                    const { options, ...control } = record;
                    const input: AdmissionRecord = { ...control, payload: { kind: 'run', request: gate.approved, options } };
                    await this.ensureAdmissionExecution(input, dbosStep);
                    await this.scheduleAdmission(input, dbosStep);
                    return DBOS.retrieveWorkflow(approvedRunWorkflowId(req.runId)).getResult();
                }
                const queuedAt = await dbosStep('fork:queued-at', async () => new Date().toISOString());
                const handle = await DBOS.startWorkflow(this.runWorkflow, {
                    workflowID: approvedRunWorkflowId(req.runId),
                    queueName: RUN_QUEUE,
                    enqueueOptions: { queuePartitionKey: req.organizationId },
                })(gate.approved, { forkApproved: true, queuedAt });
                return handle.getResult();
            },
            { name: FORK_GATE_WORKFLOW },
        );
        this.stopWorkflow = DBOS.registerWorkflow(
            async (run: StoppedRun, state: StopState, reason: string) => finalizeStoppedRun({ ...factory.forStop(run), step: dbosStep }, run, state, reason),
            { name: STOP_WORKFLOW },
        );
        const setup = this.setup;
        if (setup) {
            this.setupWorkflow = DBOS.registerWorkflow(async (cmd: RuntimeEnvironmentSetupRequested, opts?: SetupWorkflowOptions) => this.executeSetup(cmd, opts ?? {}), { name: SETUP_WORKFLOW });
        }
        if (this.config.durableAdmission) {
            this.admissionWorkflow = DBOS.registerWorkflow(async (ref: AdmissionRef, generation: number) => this.admission!.attempt(ref, generation, {
                step: dbosStep,
                schedule: async (nextRef, nextGeneration, nextAt) => {
                    const row = await dbosStep('admission:retry-reference', async () => {
                        const current = await this.admission!.store.get(nextRef);
                        return current && current.generation === nextGeneration ? { ...admissionRefOf(current), generation: current.generation, ownerEpoch: current.ownerEpoch, nextAt } : null;
                    });
                    if (row) await this.enqueueAdmissionAttempt(row, dbosStep);
                },
                wake: (id) => DBOS.setWorkflowDelay(id, 0.001),
            }), { name: ADMISSION_WORKFLOW });
        }
        DBOS.setConfig({ name: 'kody-runtime', systemDatabaseUrl: this.config.databaseUrl, logLevel: this.config.dbosLogLevel, applicationVersion: this.config.releaseVersion });
        await DBOS.launch();
        if (this.config.durableAdmission) {
            await DBOS.registerQueue(EXECUTION_QUEUE, { concurrency: this.config.admission.globalExecuting, partitionConcurrency: this.config.admission.perOrgExecuting, onConflict: 'always_update' });
            await DBOS.registerQueue(ADMISSION_QUEUE, { concurrency: this.config.admission.attemptConcurrency, partitionConcurrency: this.config.admission.attemptPerOrg, onConflict: 'always_update' });
            await DBOS.registerQueue(ADMISSION_FINALIZE_QUEUE, { concurrency: this.config.admission.attemptConcurrency, partitionConcurrency: this.config.admission.attemptPerOrg, onConflict: 'always_update' });
        } else {
            await DBOS.registerQueue(RUN_QUEUE, { concurrency: this.config.globalConcurrency, partitionConcurrency: this.config.partitionConcurrency, onConflict: 'always_update' });
            await DBOS.registerQueue(SETUP_QUEUE, { concurrency: this.config.globalConcurrency, partitionConcurrency: 1, onConflict: 'always_update' });
        }
        this.launched = true;
        this.logger.log({ msg: 'dbos.launched', queue: this.config.durableAdmission ? EXECUTION_QUEUE : RUN_QUEUE, partitionConcurrency: this.config.partitionConcurrency, globalConcurrency: this.config.globalConcurrency });
        if (this.config.sweeper) {
            this.sweeper = setInterval(() => void this.maintenanceTick(), 15_000);
            this.sweeper.unref?.();
        }
    }

    async onApplicationShutdown() {
        if (this.sweeper) clearInterval(this.sweeper);
        if (this.launched) await DBOS.shutdown();
    }

    /**
     * Enqueues the Run on the fair queue; a repeated runId returns the existing
     * workflow. A fork starts its approval gate instead (off the queue).
     */
    async start(req: RuntimeRunRequested) {
        if (this.config.durableAdmission) {
            const existing = await this.projection.get(req.runId, { organizationId: req.organizationId });
            if (existing && isTerminal(existing.state)) return req.runId;
            const accepted = await this.admission!.store.accept({ kind: 'run', request: req }, this.admission!.limits);
            if (!('record' in accepted)) {
                const canonical = await this.admission!.store.get(runRef(req));
                if (canonical) return req.runId;
                if (accepted.status === 'conflict') throw new AdmissionInputConflictError();
                if (existing) await this.finalize(stoppedRequest(req), 'errored', admissionMessage(accepted.status), true);
                return req.runId;
            }
            if (accepted.record.state === 'awaiting_approval') {
                const gate = await DBOS.startWorkflow(this.forkGateWorkflow, { workflowID: req.runId })(req);
                return gate.workflowID;
            }
            await this.ensureAdmissionExecution(accepted.record);
            if (accepted.record.state === 'cancelled') await DBOS.cancelWorkflow(accepted.record.executionId ?? req.runId);
            else await this.scheduleAdmission(accepted.record);
            return accepted.record.executionId ?? req.runId;
        }
        if (isForkApprovalRequired(req)) {
            const gate = await DBOS.startWorkflow(this.forkGateWorkflow, { workflowID: req.runId })(req);
            return gate.workflowID;
        }
        const handle = await DBOS.startWorkflow(this.runWorkflow, {
            workflowID: req.runId,
            queueName: RUN_QUEUE,
            enqueueOptions: { queuePartitionKey: req.organizationId },
        })(req, {});
        return handle.workflowID;
    }

    /**
     * Enqueues an environment setup on the per-org setup queue and returns
     * once DBOS holds it durably; the same command key starts it once.
     * False when this worker has no setup service.
     */
    async startSetup(cmd: RuntimeEnvironmentSetupRequested): Promise<string | false> {
        if (!this.setupWorkflow) return false;
        if (this.config.durableAdmission) {
            const accepted = await this.admission!.store.accept({ kind: 'setup', request: cmd }, this.admission!.limits);
            if (!('record' in accepted)) {
                const canonical = await this.admission!.store.get({ organizationId: cmd.organizationId, kind: 'setup', key: cmd.key });
                if (canonical) return canonical.executionId ?? setupWorkflowId(cmd.key);
                if (accepted.status === 'conflict') throw new AdmissionInputConflictError();
                // Rejection records only public setup identity; no large recipe or credential input is retained.
                const { environmentId, organizationId, teamId, repositoryId, repositoryName, requestedBy, requestedAt, key } = cmd;
                const handle = await DBOS.startWorkflow(this.setupWorkflow, { workflowID: `${setupWorkflowId(key)}:admission-rejected`, queueName: ADMISSION_FINALIZE_QUEUE, enqueueOptions: { queuePartitionKey: organizationId } })(
                    { environmentId, organizationId, teamId, repositoryId, repositoryName, requestedBy, requestedAt, key },
                    { admissionBlocker: { kind: 'resources', signature: accepted.status, message: admissionMessage(accepted.status) } },
                );
                return handle.workflowID;
            }
            await this.ensureAdmissionExecution(accepted.record);
            if (accepted.record.state === 'cancelled') await DBOS.cancelWorkflow(accepted.record.executionId ?? setupWorkflowId(cmd.key));
            else await this.scheduleAdmission(accepted.record);
            return accepted.record.executionId ?? setupWorkflowId(cmd.key);
        }
        const handle = await DBOS.startWorkflow(this.setupWorkflow, {
            workflowID: setupWorkflowId(cmd.key),
            queueName: SETUP_QUEUE,
            enqueueOptions: { queuePartitionKey: cmd.organizationId },
        })(cmd);
        return handle.workflowID;
    }

    /** Delivers a fork approval to the waiting gate, once per approval key. */
    async approve(runId: string, headSha: string, key: string, tokens?: ForkApprovalMessage['tokens']) {
        const message: ForkApprovalMessage = { headSha, ...(tokens ? { tokens } : {}) };
        await DBOS.send(runId, message, APPROVAL_TOPIC, key);
    }

    /**
     * Cancels the Run (its gate and its queued workflow), then starts the
     * workflow that releases, transitions and publishes, and returns at once:
     * a broker handler that stops many Runs never waits on any of them.
     */
    async stop(run: StoppedRun, state: StopState, reason: string): Promise<string> {
        if (this.config.durableAdmission) {
            const cancelled = await this.admission!.store.cancel(runRef(run), state === 'timed_out' ? 'deadline' : state === 'errored' ? 'unavailable' : 'cancelled');
            if (cancelled.changed && cancelled.releasedTicket) {
                const cleanup = await this.admission!.cleanupTicket(cancelled.releasedTicket);
                if (cleanup.status === 'failed') this.logger.warn({ msg: 'admission.ticket_cleanup_failed', organizationId: run.organizationId, key: run.runId, reason: cleanup.reason });
            }
        }
        await DBOS.cancelWorkflow(run.runId);
        if ((await DBOS.getWorkflowStatus(approvedRunWorkflowId(run.runId))) !== null) await DBOS.cancelWorkflow(approvedRunWorkflowId(run.runId));
        return this.finalize(run, state, reason);
    }

    private async finalize(run: StoppedRun, state: StopState, reason: string, bounded = false): Promise<string> {
        const input: StoppedRun = { runId: run.runId, organizationId: run.organizationId, attempt: run.attempt, correlationId: run.correlationId, headSha: run.headSha };
        const handle = await DBOS.startWorkflow(this.stopWorkflow, { workflowID: `${input.runId}:stop`, ...(bounded ? { queueName: ADMISSION_FINALIZE_QUEUE, enqueueOptions: { queuePartitionKey: input.organizationId } } : {}) })(input, state, reason);
        return handle.workflowID;
    }

    status(runId: string) {
        return DBOS.getWorkflowStatus(runId);
    }

    result(runId: string) {
        return DBOS.retrieveWorkflow(runId).getResult();
    }

    private async executeRun(req: RuntimeRunRequested, opts: RunOptions): Promise<unknown> {
        const ref = opts.admissionRef;
        if (!ref) return runRuntimeRun(req, { ...this.depsFactory.forRun(req), step: dbosStep, cancellationSignal: () => DBOS.stepStatus?.cancelSignal }, opts);
        if (!this.admission) throw new Error('admission coordinator unavailable');
        const executionId = opts.forkApproved ? approvedRunWorkflowId(req.runId) : req.runId;
        const decision = await dbosStep('admission:execute', () => this.admission!.begin(ref, executionId));
        let completed = false;
        try {
            if (decision.status === 'refused') {
                const state = terminalAdmission(decision.reason);
                await finalizeStoppedRun({ ...this.depsFactory.forStop(req), step: dbosStep }, stoppedRequest(req), state, admissionMessage(decision.reason));
                completed = true;
                return { state };
            }
            const result = await runRuntimeRun(req, {
                ...this.depsFactory.forRun(req, decision.ticket), step: dbosStep, cancellationSignal: () => DBOS.stepStatus?.cancelSignal,
            }, { ...opts, noCapacityWait: true });
            completed = true;
            return result;
        } finally {
            // A thrown SDK ownership conflict may belong to a stale execution, not a terminal workflow.
            if (completed) await dbosStep('admission:finish', () => this.finishAdmission(ref, executionId));
        }
    }

    private async executeSetup(cmd: RuntimeEnvironmentSetupRequested, opts: SetupWorkflowOptions): Promise<unknown> {
        if (!this.setup) throw new Error('setup service unavailable');
        if (!opts.admissionRef) return this.setup.run(cmd, dbosStep, () => DBOS.stepStatus?.cancelSignal, { admissionBlocker: opts.admissionBlocker });
        if (!this.admission) throw new Error('admission coordinator unavailable');
        const ref = opts.admissionRef;
        const executionId = setupWorkflowId(cmd.key);
        const decision = await dbosStep('admission:execute', () => this.admission!.begin(ref, executionId));
        let completed = false;
        try {
            const options = decision.status === 'ready'
                ? { admissionTicket: decision.ticket, noCapacityWait: true }
                : { admissionBlocker: { kind: 'resources' as const, signature: decision.reason, message: admissionMessage(decision.reason) } };
            const result = await this.setup.run(cmd, dbosStep, () => DBOS.stepStatus?.cancelSignal, options);
            completed = true;
            return result;
        } finally {
            if (completed) await dbosStep('admission:finish', () => this.finishAdmission(ref, executionId));
        }
    }

    private async finishAdmission(ref: AdmissionRef, executionId: string): Promise<void> {
        const result = await this.admission!.finish(ref, executionId);
        if (result.cleanupFailed) this.logger.warn({ msg: 'admission.ticket_cleanup_failed', organizationId: ref.organizationId, kind: ref.kind, key: ref.key, reason: result.reason });
    }

    private async ensureAdmissionExecution(record: AdmissionRecord, step?: RunDeps['step']): Promise<void> {
        if (!record.payload || !record.executionId || record.state === 'awaiting_approval') return;
        const clock = async () => Math.max(0.001, (Date.parse(record.deadlineAt ?? record.updatedAt) - Date.now()) / 1_000);
        const delaySeconds = step ? await step('admission:execution-delay', clock) : await clock();
        const parameters = { workflowID: record.executionId, queueName: EXECUTION_QUEUE, enqueueOptions: { queuePartitionKey: record.organizationId, delaySeconds } };
        const admissionRef = admissionRefOf(record);
        if (record.payload.kind === 'run') {
            await DBOS.startWorkflow(this.runWorkflow, parameters)(record.payload.request, { ...record.payload.options, admissionRef });
        } else if (this.setupWorkflow) {
            await DBOS.startWorkflow(this.setupWorkflow, parameters)(record.payload.request, { admissionRef });
        }
    }

    private async enqueueAdmissionAttempt(
        record: AdmissionRef & { generation: number; ownerEpoch: number; nextAt: string | null; deadlineAt?: string | null; maxAttempts?: number },
        step?: RunDeps['step'], repair = false,
    ): Promise<void> {
        if (!this.admissionWorkflow) throw new Error('admission workflow unavailable');
        const clock = async () => {
            const now = Date.now();
            return { now, delaySeconds: Math.max(0.001, (Date.parse(record.nextAt ?? new Date(now).toISOString()) - now) / 1_000) };
        };
        const timing = step ? await step('admission:attempt-delay', clock) : await clock();
        let workflowID = admissionAttemptWorkflowId(record, record.generation, record.ownerEpoch);
        const existing = await DBOS.getWorkflowStatus(workflowID);
        if (existing) {
            if (!repair || !['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(existing.status)) return;
            const origin = Date.parse(record.deadlineAt ?? new Date(timing.now).toISOString()) - ADMISSION_WAIT_MS;
            const bucket = Math.max(0, Math.min(record.maxAttempts ?? this.admission!.limits.maxAttempts, Math.floor((timing.now - origin) / this.admission!.limits.retryMs)));
            workflowID = admissionAttemptWorkflowId(record, record.generation, record.ownerEpoch, bucket);
            if (await DBOS.getWorkflowStatus(workflowID)) return;
        }
        await DBOS.startWorkflow(this.admissionWorkflow, {
            workflowID, queueName: ADMISSION_QUEUE,
            enqueueOptions: { queuePartitionKey: record.organizationId, delaySeconds: timing.delaySeconds },
        })(admissionRefOf(record), record.generation);
    }

    private async scheduleAdmission(record: AdmissionRecord, step?: RunDeps['step'], repair = false): Promise<void> {
        if (record.state === 'dispatched' || ['expired', 'rejected'].includes(record.state)) {
            if (record.executionId) await DBOS.setWorkflowDelay(record.executionId, 0.001);
        } else if (['waiting', 'owned', 'reserved'].includes(record.state)) {
            await this.enqueueAdmissionAttempt(record, step, repair);
        }
    }

    /** Public SDK statuses plus scoped claim cleanup reconcile permits; lease expiry alone never does. */
    async repairAdmission(now = new Date()): Promise<void> {
        if (!this.config.durableAdmission || !this.admission) return;
        const began = Date.now();
        for (const ref of await this.admission.store.due(100)) {
            // Complete the current bounded RPC; do not leave detached cleanup mutations behind.
            if (Date.now() - began >= 5_000) break;
            try {
                const record = await this.admission.store.get(ref);
                if (!record?.payload) continue;
                if (record.state === 'awaiting_approval') {
                    if (record.payload.kind !== 'run') continue;
                    if (record.approvalDeadlineAt && Date.parse(record.approvalDeadlineAt) <= now.getTime()) {
                        const req = record.payload.request;
                        await this.stop(stoppedRequest(req), 'timed_out', 'fork approval expired');
                    } else {
                        await DBOS.startWorkflow(this.forkGateWorkflow, { workflowID: record.payload.request.runId })(record.payload.request);
                    }
                    continue;
                }
                if (!record.executionId) continue;
                const workflow = await DBOS.getWorkflowStatus(record.executionId);
                if (record.state === 'completed' || workflow && ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(workflow.status)) {
                    if (record.payload.kind === 'run' && workflow && workflow.status !== 'SUCCESS') {
                        const req = record.payload.request;
                        const projection = await this.projection.get(req.runId, { organizationId: req.organizationId });
                        if (projection && !isTerminal(projection.state)) await this.finalize(stoppedRequest(req), workflow.status === 'CANCELLED' ? terminalAdmission(record.lastReason ?? 'cancelled') : 'errored', admissionMessage(record.lastReason ?? 'unavailable'));
                    }
                    await this.finishAdmission(record, record.executionId);
                    continue;
                }
                if (record.state === 'cancelled') {
                    if (workflow) await DBOS.cancelWorkflow(record.executionId);
                    if (record.payload.kind === 'run') {
                        const req = record.payload.request;
                        await this.finalize(stoppedRequest(req), terminalAdmission(record.lastReason ?? 'cancelled'), admissionMessage(record.lastReason ?? 'cancelled'));
                    }
                    await this.finishAdmission(record, record.executionId);
                    continue;
                }
                // A fork that never received approval has no approved execution row to create.
                if (!record.deadlineAt && record.payload.kind === 'run') {
                    const req = record.payload.request;
                    await this.stop(stoppedRequest(req), 'timed_out', 'fork approval expired');
                    await this.finishAdmission(record, record.executionId);
                    continue;
                }
                if (!workflow) await this.ensureAdmissionExecution(record);
                if (record.state !== 'running') await this.scheduleAdmission(record, undefined, true);
            } catch {
                this.logger.warn({ msg: 'admission.repair_failed', organizationId: ref.organizationId, kind: ref.kind, key: ref.key });
            }
        }
    }

    /** One maintenance tick per cluster: the replica that takes the lock sweeps, reaps and applies retention. */
    async maintenanceTick(now = new Date()): Promise<boolean> {
        try {
            const ran = await this.locks.tryWithLock(MAINTENANCE_LOCK, async () => {
                await this.repairAdmission(now);
                await this.sweep(now);
                await this.depsFactory.reap(now, this.metrics);
                if (this.retention && now.getTime() - this.lastRetentionAt >= RETENTION_EVERY_MS) {
                    this.lastRetentionAt = now.getTime();
                    const removed = await this.retention();
                    if (removed) this.logger.log({ msg: 'retention.applied', rows: removed });
                }
                return true;
            });
            return ran === true;
        } catch (e) {
            this.logger.warn({ msg: 'maintenance.failed', error: (e as Error)?.message });
            return false;
        }
    }

    /** Runs the engine stopped by itself (45 min timeout, error) and the 30 min queue limit. */
    async sweep(now = new Date()) {
        const since = new Date(now.getTime() - 6 * 3_600_000).toISOString();
        const stuck = (
            await Promise.all(
                [RUN_WORKFLOW, FORK_GATE_WORKFLOW].map((workflowName) => DBOS.listWorkflows({ workflowName, status: ['CANCELLED', 'ERROR', 'ENQUEUED'], startTime: since, limit: 200 })),
            )
        ).flat();
        const seen = new Set<string>();
        for (const wf of stuck) {
            const runId = runIdOfWorkflow(wf.workflowID);
            if (seen.has(runId)) continue;
            seen.add(runId);
            const run = await this.projection.get(runId);
            if (!run || isTerminal(run.state)) continue;
            if (wf.status === 'ENQUEUED' && now.getTime() - wf.createdAt <= QUEUE_TIMEOUT_MS) continue;
            const state: StopState = wf.status === 'ERROR' ? 'errored' : 'timed_out';
            const reason = wf.status === 'ENQUEUED' ? '30 min in the queue' : wf.status === 'ERROR' ? 'workflow failed' : '45 min';
            this.logger.warn({ msg: 'sweep.finalize', runId, status: wf.status, state });
            await this.stop(stoppedRun(run), state, reason);
        }
        // 45 min from booting (§3), not counting a wait for room; the DBOS timeout is not used so a fork can wait for approval.
        for (const run of await this.projection.listLive()) {
            // A projection written before a workflow that never started (DBOS down, retries spent):
            // nothing above sees it, and it holds its SHA (one live Run per SHA) for ever.
            if (queuedPastLimit(run, now) && (await DBOS.getWorkflowStatus(run.runId)) === null && !(this.config.durableAdmission && await this.admission!.store.get(runRef(run)))) {
                this.logger.warn({ msg: 'sweep.never_started', runId: run.runId });
                await this.finalize(stoppedRun(run), 'errored', 'never started');
                continue;
            }
            if (runPastLimit(run, now)) {
                await this.stop(stoppedRun(run), 'timed_out', '45 min');
            }
        }
    }
}

/**
 * Booting or testing for longer than the Run's 45 min (§3). They count from
 * when both sides had room (ADR-070): the Run moves bootingAt there once
 * both booted, and until then, while a side waits for room or boots on the
 * room it just got, from the last refusal (capacityWait.at), which the wait
 * records every round. A worker that died mid-wait stops recording it, so
 * its Run is still swept 45 min after.
 */
export function runPastLimit(run: Pick<RuntimeRunProjection, 'state' | 'bootingAt' | 'capacityWait'>, now: Date): boolean {
    if (!(run.state === 'booting' || run.state === 'testing') || !run.bootingAt) return false;
    const refusedAt = run.capacityWait?.at ? Date.parse(run.capacityWait.at) : NaN;
    const from = Math.max(Date.parse(run.bootingAt), Number.isFinite(refusedAt) ? refusedAt : -Infinity);
    return now.getTime() - from > RUN_TIMEOUT_MS;
}

/**
 * Queued past the queue limit, plus a margin for the consumer's retries: if
 * no workflow stands behind it, it never started and never will.
 */
export function queuedPastLimit(run: Pick<RuntimeRunProjection, 'state' | 'requestedAt'>, now: Date): boolean {
    return run.state === 'queued' && now.getTime() - Date.parse(run.requestedAt) > QUEUE_TIMEOUT_MS + 5 * 60_000;
}
