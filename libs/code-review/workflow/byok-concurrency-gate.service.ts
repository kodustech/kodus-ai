import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

import { LLM_TASK } from '@libs/llm/byok-config';
import type { BYOKConfig, NormalizedModel } from '@libs/llm/byok-config';
import { resolveTaskSlot } from '@libs/llm/resolve-task-model';
import { overrideContext } from '@libs/llm/routing-strategy';
import {
    isHeavyReview,
    type RequestedReviewMode,
} from '@libs/code-review/domain/review-mode';
import { getMappedPlatform } from '@libs/common/utils/webhooks';
import { stripCurlyBracesFromUUIDs } from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-bitbucket.type';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

import {
    OrganizationParametersKey,
    ParametersKey,
    PlatformType,
} from '@libs/core/domain/enums';
import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { IWorkflowJob } from '@libs/core/workflow/domain/interfaces/workflow-job.interface';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import {
    IMessageBrokerService,
    MESSAGE_BROKER_SERVICE_TOKEN,
} from '@libs/core/domain/contracts/message-broker.service.contracts';
import type { DistributedLock } from '@libs/core/workflow/infrastructure/distributed-lock.service';

type MainByokSlotConfig = NormalizedModel;

@Injectable()
export class ByokConcurrencyGateService {
    private readonly logger = createLogger(ByokConcurrencyGateService.name);
    private static readonly BASE_DELAY_MS = 15_000;
    private static readonly MAX_DELAY_MS = 5 * 60_000;
    private static readonly MAX_DEFERRALS = 10;

    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        private readonly distributedLockService: DistributedLockService,
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outboxRepository: IOutboxMessageRepository,
        @Inject(MESSAGE_BROKER_SERVICE_TOKEN)
        private readonly messageBroker: IMessageBrokerService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService?: IParametersService,
    ) {}

    async tryEnter(
        job: IWorkflowJob,
    ): Promise<
        | { kind: 'unlimited' }
        | { kind: 'acquired'; lock: DistributedLock }
        | { kind: 'deferred'; delayMs: number; deferredCount: number }
        | { kind: 'exhausted'; deferredCount: number }
    > {
        const slotConfig = await this.getLimitedMainConfig(job);
        if (!slotConfig) {
            return { kind: 'unlimited' };
        }

        const scopeKey = this.buildScopeKey(job, slotConfig);
        const maxConcurrentRequests = slotConfig.maxConcurrentRequests!;

        for (
            let slotIndex = 0;
            slotIndex < maxConcurrentRequests;
            slotIndex++
        ) {
            const lock = await this.distributedLockService.acquire(
                `${scopeKey}:slot:${slotIndex}`,
            );

            if (lock) {
                this.logger.log({
                    message:
                        '[BYOK-CONCURRENCY-GATE] acquired distributed BYOK slot',
                    context: ByokConcurrencyGateService.name,
                    metadata: {
                        jobId: job.id,
                        scopeKey,
                        slotIndex,
                        maxConcurrentRequests,
                    },
                });

                return { kind: 'acquired', lock };
            }
        }

        const deferredCount = this.getDeferredCount(job) + 1;

        if (deferredCount > ByokConcurrencyGateService.MAX_DEFERRALS) {
            this.logger.error({
                message:
                    '[BYOK-CONCURRENCY-GATE] max deferrals exceeded — forcing acquisition, then giving up if it fails',
                context: ByokConcurrencyGateService.name,
                metadata: {
                    jobId: job.id,
                    scopeKey,
                    deferredCount,
                    maxDeferrals: ByokConcurrencyGateService.MAX_DEFERRALS,
                },
            });

            const lock = await this.distributedLockService.acquire(
                `${scopeKey}:slot:0`,
                { ttl: 30_000 },
            );

            if (lock) {
                return { kind: 'acquired', lock };
            }

            // Deferring again here made MAX_DEFERRALS a label rather than a
            // limit: the forced acquisition targets `slot:0`, so when that
            // slot is the one that leaked, this branch could never succeed
            // and the job came straight back to it. Production showed
            // `deferredCount` at 452 against a cap of 10, across 315 jobs
            // and 4 organizations -- 1416 error lines in 24h from one
            // service, and four customers whose reviews never ran and who
            // were never told.
            //
            // A cap that does not stop anything is worse than no cap: it
            // spends the retry budget forever and reports the fact at
            // `error` on every turn, which trains everyone to ignore the
            // log. Give up instead, and let the caller answer the person
            // who asked.
            return { kind: 'exhausted', deferredCount };
        }

        const delayMs = this.calculateDelayMs(deferredCount);

        this.logger.warn({
            message: '[BYOK-CONCURRENCY-GATE] all slots busy, deferring job',
            context: ByokConcurrencyGateService.name,
            metadata: {
                jobId: job.id,
                scopeKey,
                maxConcurrentRequests,
                deferredCount,
                delayMs,
            },
        });

        return { kind: 'deferred', delayMs, deferredCount };
    }

    /**
     * Defers a job by writing an outbox entry with a future `nextAttemptAt`.
     * The existing outbox relay picks it up after the delay and publishes
     * to the regular workflow exchange — no delayed-exchange plugin needed.
     */
    async deferJob(
        job: IWorkflowJob,
        deferred: { delayMs: number; deferredCount: number },
    ): Promise<void> {
        const nextAttemptAt = new Date(Date.now() + deferred.delayMs);

        await this.jobRepository.update(job.id, {
            status: JobStatus.PENDING,
            scheduledAt: nextAttemptAt,
            lastError:
                'Waiting for a BYOK concurrency slot before starting agent review',
            metadata: {
                ...(job.metadata || {}),
                byokConcurrencyGate: {
                    deferredCount: deferred.deferredCount,
                    delayMs: deferred.delayMs,
                    deferredAt: new Date().toISOString(),
                    nextAttemptAt: nextAttemptAt.toISOString(),
                },
            },
        });

        const payload = {
            jobId: job.id,
            correlationId: job.correlationId,
            workflowType: job.workflowType,
            handlerType: job.handlerType,
            organizationId: job.organizationAndTeamData?.organizationId,
            teamId: job.organizationAndTeamData?.teamId,
        };

        await this.outboxRepository.create({
            jobId: job.id,
            exchange: 'workflow.exchange',
            routingKey: `workflow.jobs.deferred.${job.workflowType}`,
            payload: this.messageBroker.transformMessageToMessageBroker({
                eventName: 'workflow.jobs.deferred',
                message: payload,
            }) as unknown as Record<string, unknown>,
            nextAttemptAt,
        });

        this.logger.warn({
            message:
                '[BYOK-CONCURRENCY-GATE] deferred workflow job via outbox relay',
            context: ByokConcurrencyGateService.name,
            metadata: {
                jobId: job.id,
                correlationId: job.correlationId,
                delayMs: deferred.delayMs,
                deferredCount: deferred.deferredCount,
                nextAttemptAt: nextAttemptAt.toISOString(),
            },
        });
    }

    private async getLimitedMainConfig(
        job: IWorkflowJob,
    ): Promise<MainByokSlotConfig | null> {
        const organizationAndTeamData = job.organizationAndTeamData;
        if (!organizationAndTeamData?.organizationId) {
            return null;
        }

        try {
            const byokParameter =
                await this.organizationParametersService.findByKey(
                    OrganizationParametersKey.BYOK_CONFIG,
                    organizationAndTeamData,
                );

            // Most orgs cap nothing: answer before reading the review's route,
            // which costs a config read on every job.
            const models = (
                byokParameter?.configValue as BYOKConfig | null | undefined
            )?.models;
            if (!models?.some((m) => (m?.maxConcurrentRequests ?? 0) > 0)) {
                return null;
            }

            const route = await this.reviewRoute(job);

            // Resolve the review's slot through the SAME resolution primitive
            // every consumer uses (`resolveTaskSlot`: isByokConfig guard →
            // StaticTaskStrategy → resolveModelSlot) — NOT a parallel resolver.
            // The slot carries CIPHERTEXT apiKey and is used only for the scope
            // key hash + the concurrency limit — the gate NEVER decrypts, so we
            // route to the slot WITHOUT building a model (no buildModelFromSlot).
            const { slot: mainConfig } = resolveTaskSlot(
                byokParameter?.configValue as BYOKConfig | null | undefined,
                route.heavy ? LLM_TASK.codeReviewHeavy : LLM_TASK.codeReview,
                {
                    ctx: overrideContext(route.byokModelId, route.byokModel),
                },
            );

            if (
                !mainConfig?.provider ||
                !mainConfig?.model ||
                !mainConfig?.apiKey ||
                !mainConfig.maxConcurrentRequests ||
                mainConfig.maxConcurrentRequests <= 0
            ) {
                return null;
            }

            return mainConfig;
        } catch (error) {
            this.logger.warn({
                message:
                    '[BYOK-CONCURRENCY-GATE] failed to resolve BYOK config, proceeding without gate',
                context: ByokConcurrencyGateService.name,
                metadata: {
                    jobId: job.id,
                    organizationId: organizationAndTeamData.organizationId,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });

            return null;
        }
    }

    /**
     * The review mode and the repository's model this job's review runs on, as
     * far as the gate can tell before the pipeline: the mode the command asked
     * for, else the one set globally or on the repository, and the
     * repository's model. A mode or model set only on a directory or in
     * kodus-config.yml needs the PR's files and is not seen here; the per-call
     * limiter still applies the real model's limit.
     */
    private async reviewRoute(job: IWorkflowJob): Promise<{
        heavy: boolean;
        byokModelId?: string;
        byokModel?: string;
    }> {
        const payload = (job.payload ?? {}) as Record<string, any>;
        const codeManagementPayload = payload.codeManagementPayload ?? {};
        const requested = codeManagementPayload.requestedReviewMode as
            RequestedReviewMode | undefined;
        const teamId = job.organizationAndTeamData?.teamId;
        if (!this.parametersService || !teamId) {
            return { heavy: isHeavyReview(requested, undefined) };
        }

        const platformType = payload.platformType as PlatformType;
        let repositoryId: string | undefined;
        try {
            repositoryId = getMappedPlatform(platformType)?.mapRepository({
                payload:
                    platformType === PlatformType.BITBUCKET
                        ? stripCurlyBracesFromUUIDs(codeManagementPayload)
                        : codeManagementPayload,
            })?.id;
        } catch {
            // An unmappable payload gates on the global config.
        }

        // A config that cannot be read gates on the command's mode alone,
        // rather than dropping the gate.
        const parameter = await this.parametersService
            .findOne({
                configKey: ParametersKey.CODE_REVIEW_CONFIG,
                team: { uuid: teamId },
                active: true,
            })
            .catch((error) => {
                this.logger.warn({
                    message:
                        '[BYOK-CONCURRENCY-GATE] failed to read the code review config, gating on the requested mode',
                    context: ByokConcurrencyGateService.name,
                    metadata: {
                        jobId: job.id,
                        organizationId:
                            job.organizationAndTeamData?.organizationId,
                        teamId,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                });
                return null;
            });
        const globalConfig = parameter?.configValue?.configs ?? {};
        const repoConfig =
            (repositoryId !== undefined &&
                parameter?.configValue?.repositories?.find(
                    (repo) => String(repo.id) === String(repositoryId),
                )?.configs) ||
            {};

        return {
            heavy: isHeavyReview(
                requested,
                repoConfig.reviewMode ?? globalConfig.reviewMode,
            ),
            byokModelId: repoConfig.byokModelId,
            byokModel: repoConfig.byokModel,
        };
    }

    private buildScopeKey(
        job: IWorkflowJob,
        slotConfig: MainByokSlotConfig,
    ): string {
        const accountFingerprint = createHash('sha256')
            .update(
                [
                    slotConfig.provider,
                    slotConfig.apiKey,
                    slotConfig.baseURL || '',
                ].join('::'),
            )
            .digest('hex')
            .slice(0, 16);

        return [
            'byok-concurrency',
            job.organizationAndTeamData?.organizationId || 'global',
            slotConfig.provider,
            accountFingerprint,
            slotConfig.baseURL || '',
            slotConfig.model || '',
        ].join('::');
    }

    private getDeferredCount(job: IWorkflowJob): number {
        const currentValue = (job.metadata as Record<string, unknown> | null)
            ?.byokConcurrencyGate as { deferredCount?: unknown } | undefined;

        return typeof currentValue?.deferredCount === 'number'
            ? currentValue.deferredCount
            : 0;
    }

    private calculateDelayMs(deferredCount: number): number {
        return Math.min(
            ByokConcurrencyGateService.BASE_DELAY_MS *
                2 ** Math.max(0, deferredCount - 1),
            ByokConcurrencyGateService.MAX_DELAY_MS,
        );
    }
}
