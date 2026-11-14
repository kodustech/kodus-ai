import { createHash, randomUUID } from 'node:crypto';
import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import {
    EXTERNAL_FINDING_LIMITS,
    SubmitFindingsSchema,
    VerifyFindingSchema,
    type SubmitFindings,
} from '@libs/runtime/contracts/external-findings';
import type { Probe } from '@libs/runtime/probe/probe.schema';
import { RuntimeRunRequestedSchema } from '@libs/runtime/run/run-messages';
import type { EnvKeyPrincipal } from '../domain/env-tools';
import {
    canonicalExternalJSON,
    ExternalAdmissionError,
    EXTERNAL_VERIFICATION_TTL_MS,
    RUNTIME_EXTERNAL_FINDINGS_STORE,
    RUNTIME_EXTERNAL_STOP_READER,
    type ExternalFindingsPort,
    type ExternalFindingsStore,
    type ExternalStopReader,
    type ExternalSubmissionAdmission,
    type ExternalSubmissionRecord,
    type ExternalTaskView,
} from '../domain/external-findings';
import { deterministicUuid } from '../domain/deterministic-id';
import {
    RUNTIME_CLOCK,
    RUNTIME_ENVIRONMENT_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_RUN_PROJECTION_STORE,
    type Clock,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RunProjectionReader,
    type RuntimeEnvironmentReader,
    type RuntimeGitPort,
} from '../domain/ports';
import { RuntimeRunRequestBuilder } from './run-request-builder.service';
import { ExternalVerificationReconciler } from './external-verification-reconciler';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hash = (value: unknown) =>
    createHash('sha256').update(canonicalExternalJSON(value)).digest('hex');

/** Submitted observations are neither persisted proof nor a reason to rerun an identical claim. */
function executionInput(input: SubmitFindings): SubmitFindings {
    return {
        ...input,
        findings: input.findings.map(({ evidence, ...finding }) => ({
            ...finding,
            ...(evidence?.probe
                ? {
                      evidence: {
                          probe: {
                              ...evidence.probe,
                              id: 'external',
                              origin: 'external' as const,
                          },
                      },
                  }
                : {}),
        })),
    };
}

function targetAllowed(
    probe: Probe,
    expose: NonNullable<
        Awaited<ReturnType<RuntimeEnvironmentReader['get']>>
    >['expose'],
): boolean {
    const spec = probe.spec;
    if (spec.kind === 'shell') return false;
    if (spec.kind === 'browser')
        return !!expose?.some((p) => p.kind === 'http');
    return !!expose?.some(
        (p) =>
            p.service === spec.target.service &&
            p.port === spec.target.port &&
            (spec.kind === 'http'
                ? p.kind === 'http'
                : p.kind === 'postgres' || p.kind === 'mysql'),
    );
}

/** Product-owned admission/task state only. Execution and verdicts remain in the durable Runtime Run. */
@Injectable()
export class ExternalFindingsService implements ExternalFindingsPort {
    constructor(
        @Inject(RUNTIME_EXTERNAL_FINDINGS_STORE)
        private readonly store: ExternalFindingsStore,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: ProductEnvironmentStore,
        @Inject(RUNTIME_GIT_PORT) private readonly git: RuntimeGitPort,
        @Inject(RUNTIME_ENVIRONMENT_READER)
        private readonly images: RuntimeEnvironmentReader,
        @Inject(RUNTIME_RUN_PROJECTION_STORE)
        private readonly runs: RunProjectionReader,
        @Inject(RUNTIME_EXTERNAL_STOP_READER)
        private readonly stops: ExternalStopReader,
        private readonly requests: RuntimeRunRequestBuilder,
        @Inject(RUNTIME_CLOCK) private readonly now: Clock,
    ) {}

    async submit(
        principal: EnvKeyPrincipal,
        raw: unknown,
        messageId: string,
    ): Promise<ExternalTaskView> {
        this.capability(principal, 'findings:submit');
        this.messageId(messageId);
        let bytes: number;
        try {
            bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
        } catch {
            throw new BadRequestException(
                'Invalid external finding submission',
            );
        }
        if (bytes > EXTERNAL_FINDING_LIMITS.bodyBytes)
            throw new BadRequestException(
                'External finding submission exceeds its byte budget',
            );
        const parsed = SubmitFindingsSchema.safeParse(raw);
        if (!parsed.success)
            throw new BadRequestException(
                'Invalid external finding submission',
            );
        const input = parsed.data;
        if (!principal.repositoryIds.includes(input.repositoryId))
            throw new NotFoundException('Repository not found');
        const environment = await this.environments.findByRepository(
            principal.organizationId,
            input.repositoryId,
        );
        if (
            !environment ||
            environment.organizationId !== principal.organizationId ||
            environment.teamId !== principal.teamId
        )
            throw new NotFoundException('Environment not found');
        const submitted = executionInput(input);
        const hasProbes = submitted.findings.some((f) => f.evidence?.probe);
        if (hasProbes) this.capability(principal, 'env:exec');
        const bodyHash = hash(input);
        const fingerprint = hash(submitted);
        const alias = await this.store.byMessage(
            principal.organizationId,
            principal.keyId,
            messageId,
        );
        if (alias) {
            this.scope(principal, alias.record);
            if (alias.bodyHash !== bodyHash)
                throw new ConflictException(
                    'Message id was already used with different content',
                );
            return this.receipt(alias.record, true);
        }
        const duplicate = await this.store.byFingerprint(
            principal.organizationId,
            principal.keyId,
            fingerprint,
        );
        if (duplicate) {
            this.scope(principal, duplicate);
            const admitted = await this.admit({
                record: duplicate,
                reuseOnly: true,
                messageId,
                bodyHash,
            });
            return this.receipt(admitted.record, true);
        }
        const prepared = await this.prepare(
            principal,
            submitted,
            fingerprint,
            environment,
        );
        const admitted = await this.admit({ ...prepared, messageId, bodyHash });
        return this.receipt(admitted.record, admitted.deduplicated);
    }

    private async prepare(
        principal: EnvKeyPrincipal,
        submitted: SubmitFindings,
        fingerprint: string,
        environment: ProductEnvironment,
        findingIdsOverride?: string[],
        attempt = 1,
    ): Promise<Pick<ExternalSubmissionAdmission, 'record' | 'request'>> {
        const input = submitted;
        if (
            !(await this.store.quotaAvailable(
                principal.organizationId,
                principal.keyId,
                input.repositoryId,
                input.prNumber,
                this.now().toISOString(),
                input.findings.length,
            ))
        )
            throw new HttpException('External finding quota reached', 429);
        const hasProbes = submitted.findings.some((f) => f.evidence?.probe);
        const head = await this.git.getPullRequestHead({
            organizationId: principal.organizationId,
            teamId: principal.teamId,
            repositoryId: environment.repositoryId,
            repositoryName: environment.repositoryName,
            prNumber: input.prNumber,
        });
        if (!head) throw new NotFoundException('Pull request not found');
        if (head.state !== 'open' || head.headSha !== input.headSha)
            throw new ConflictException(
                'The pull request must be open at the submitted head SHA',
            );
        const at = this.now();
        // Stored message/fingerprint uniqueness provides idempotency. A new
        // admission after retention must not resurrect an old DBOS Run.
        const receiptId = randomUUID();
        const taskId = deterministicUuid('external-verification', receiptId);
        const findingIds =
            findingIdsOverride ??
            submitted.findings.map((_, index) =>
                deterministicUuid('external-finding', receiptId, index),
            );
        const record: ExternalSubmissionRecord = {
            receiptId,
            attempt,
            verificationTaskId: taskId,
            organizationId: principal.organizationId,
            teamId: principal.teamId,
            keyId: principal.keyId,
            repositoryId: input.repositoryId,
            prNumber: input.prNumber,
            headSha: input.headSha,
            fingerprint,
            findingIds,
            submission: submitted,
            createdAt: at.toISOString(),
            expiresAt: new Date(
                at.getTime() + EXTERNAL_VERIFICATION_TTL_MS,
            ).toISOString(),
        };
        let stopped: boolean;
        try {
            stopped = await this.stops.isStopped(principal.organizationId);
        } catch {
            throw new ServiceUnavailableException(
                'Runtime stop state is unavailable',
            );
        }
        const image = await this.images.get(
            principal.organizationId,
            environment.environmentId,
        );
        const live = await this.runs.findLive({
            organizationId: principal.organizationId,
            repositoryId: input.repositoryId,
            prNumber: input.prNumber,
        });
        if (!hasProbes) record.refusal = 'execution_probe_required';
        else if (head.fork !== false) record.refusal = 'fork_approval_required';
        else if (stopped) record.refusal = 'runtime_stopped';
        else if (live.some((r) => r.headSha === input.headSha))
            record.refusal = 'run_in_progress';
        else if (
            environment.state !== 'active' ||
            !image?.imageId ||
            image.teamId !== principal.teamId ||
            image.repositoryId !== input.repositoryId
        )
            record.refusal = 'environment_not_ready';
        if (record.refusal) return { record };
        const findings = submitted.findings.flatMap((f, index) =>
            f.evidence?.probe
                ? [
                      {
                          findingId: findingIds[index],
                          probe: {
                              ...f.evidence.probe,
                              id: findingIds[index],
                              origin: 'external' as const,
                          },
                      },
                  ]
                : [],
        );
        if (findings.some(({ probe }) => !targetAllowed(probe, image!.expose)))
            throw new BadRequestException(
                'An external probe targets a service not exposed by this environment',
            );
        const built = await this.requests.build({
            env: environment,
            head,
            prNumber: input.prNumber,
            trigger: 'external_finding',
            runId: deterministicUuid('external-run', taskId),
            externalVerification: { taskId, source: input.source, findings },
        });
        const request = RuntimeRunRequestedSchema.parse(built);
        if (
            findings.some(
                ({ probe }) =>
                    !targetAllowed(probe, request.environment.expose),
            )
        )
            throw new ConflictException(
                'The environment changed while preparing verification',
            );
        record.runId = request.runId;
        record.imageId = request.environment.imageId;
        return { record, request };
    }

    async verify(
        principal: EnvKeyPrincipal,
        raw: unknown,
        messageId: string,
    ): Promise<ExternalTaskView> {
        this.capability(principal, 'findings:submit');
        this.messageId(messageId);
        const parsed = VerifyFindingSchema.safeParse(raw);
        if (!parsed.success)
            throw new BadRequestException(
                'Invalid finding verification request',
            );
        const bodyHash = hash({ operation: 'verify_finding', ...parsed.data });
        const alias = await this.store.byMessage(
            principal.organizationId,
            principal.keyId,
            messageId,
        );
        if (alias) {
            this.scope(principal, alias.record);
            if (alias.bodyHash !== bodyHash)
                throw new ConflictException(
                    'Message id was already used with different content',
                );
            if (alias.record.submission.findings.some((f) => f.evidence?.probe))
                this.capability(principal, 'env:exec');
            return this.verification(alias.record);
        }
        const record = await this.store.byFinding(
            principal.organizationId,
            parsed.data.findingId,
        );
        if (!record) throw new NotFoundException('Finding not found');
        this.scope(principal, record);
        if (record.submission.findings.some((f) => f.evidence?.probe))
            this.capability(principal, 'env:exec');
        const current = await this.verification(record);
        const retryable =
            (record.refusal &&
                [
                    'runtime_stopped',
                    'run_in_progress',
                    'environment_not_ready',
                ].includes(record.refusal)) ||
            (current.state === 'failed' &&
                [
                    'verification_deadline_exceeded',
                    'verification_run_did_not_finish',
                ].includes(String(current.result.reason)));
        if (!retryable) return this.boundCurrent(record, messageId, bodyHash);
        const index = record.findingIds.indexOf(parsed.data.findingId);
        const finding = record.submission.findings[index];
        if (!finding?.evidence?.probe)
            return this.boundCurrent(record, messageId, bodyHash);
        const environment = await this.environments.findByRepository(
            principal.organizationId,
            record.repositoryId,
        );
        if (
            !environment ||
            environment.organizationId !== principal.organizationId ||
            environment.teamId !== principal.teamId
        )
            throw new NotFoundException('Environment not found');
        const submitted = { ...record.submission, findings: [finding] };
        const fingerprint = hash({
            retryOf: record.verificationTaskId,
            findingId: parsed.data.findingId,
        });
        const prepared = await this.prepare(
            principal,
            submitted,
            fingerprint,
            environment,
            [parsed.data.findingId],
            record.attempt + 1,
        );
        const admitted = await this.admit({ ...prepared, messageId, bodyHash });
        return this.verification(admitted.record);
    }

    async getTask(
        principal: EnvKeyPrincipal,
        taskId: string,
    ): Promise<ExternalTaskView> {
        this.capability(principal, 'findings:submit');
        if (!UUID.test(taskId)) throw new NotFoundException('Task not found');
        const record = await this.store.byTask(
            principal.organizationId,
            taskId,
        );
        if (!record) throw new NotFoundException('Task not found');
        this.scope(principal, record);
        return taskId === record.receiptId
            ? this.receipt(record, true)
            : this.verification(record);
    }

    private capability(principal: EnvKeyPrincipal, capability: string) {
        if (!principal.capabilities.includes(capability))
            throw new ForbiddenException(
                'Team key lacks the required exact capability',
            );
    }
    private scope(
        principal: EnvKeyPrincipal,
        record: ExternalSubmissionRecord,
    ) {
        if (
            record.organizationId !== principal.organizationId ||
            record.teamId !== principal.teamId ||
            record.keyId !== principal.keyId ||
            !principal.repositoryIds.includes(record.repositoryId)
        )
            throw new NotFoundException('Task not found');
    }
    private messageId(id: string) {
        if (
            typeof id !== 'string' ||
            id.length < 1 ||
            id.length > 128 ||
            /[\x00-\x1f]/.test(id)
        )
            throw new BadRequestException('Invalid message id');
    }
    private receipt(
        record: ExternalSubmissionRecord,
        deduplicated: boolean,
    ): ExternalTaskView {
        return {
            id: record.receiptId,
            contextId: record.receiptId,
            state: 'completed',
            result: {
                accepted: record.findingIds.length,
                findingIds: record.findingIds,
                deduplicated,
                verificationTaskId: record.verificationTaskId,
            },
            createdAt: record.createdAt,
            updatedAt: record.createdAt,
        };
    }
    /** Reusing a task still binds this message before answering it. */
    private async boundCurrent(
        record: ExternalSubmissionRecord,
        messageId: string,
        bodyHash: string,
    ): Promise<ExternalTaskView> {
        const admitted = await this.admit({
            record,
            messageId,
            bodyHash,
            reuseOnly: true,
        });
        return this.verification(admitted.record);
    }
    private async admit(
        input: Omit<Parameters<ExternalFindingsStore['admit']>[0], 'at'>,
    ) {
        try {
            return await this.store.admit({
                ...input,
                at: this.now().toISOString(),
            });
        } catch (e) {
            if (e instanceof ExternalAdmissionError) {
                if (e.code === 'receipt_expired')
                    throw new NotFoundException(
                        'External task retention window expired',
                    );
                if (e.code !== 'idempotency_conflict')
                    throw new HttpException(
                        'External finding quota reached',
                        429,
                    );
                throw new ConflictException(
                    'Message id was already used with different content',
                );
            }
            throw e;
        }
    }
    private verification(
        record: ExternalSubmissionRecord,
    ): Promise<ExternalTaskView> {
        return new ExternalVerificationReconciler(
            this.store,
            this.runs,
            this.now,
        ).reconcile(record);
    }
}
