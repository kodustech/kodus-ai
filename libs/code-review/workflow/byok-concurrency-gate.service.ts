import { createLogger } from '@kodus/flow';
import { BYOKConfig } from '@kodus/kodus-common/llm';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
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

type MainByokSlotConfig = NonNullable<BYOKConfig['main']>;

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
    ) {}

    async tryEnter(
        job: IWorkflowJob,
    ): Promise<
        | { kind: 'unlimited' }
        | { kind: 'acquired'; lock: DistributedLock }
        | { kind: 'deferred'; delayMs: number; deferredCount: number }
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
                    '[BYOK-CONCURRENCY-GATE] max deferrals exceeded, forcing acquisition',
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

            return {
                kind: 'deferred',
                delayMs: ByokConcurrencyGateService.MAX_DELAY_MS,
                deferredCount,
            };
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

            const byokConfig = byokParameter?.configValue as
                | BYOKConfig
                | undefined;
            const mainConfig = byokConfig?.main;

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
