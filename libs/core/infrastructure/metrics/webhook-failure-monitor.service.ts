import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '@kodus/flow';
import { WorkflowJobModel } from '@libs/core/workflow/infrastructure/repositories/schemas/workflow-job.model';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { IncidentManagerService } from '../incident/incident-manager.service';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { buildHeartbeatContext } from '../incident/heartbeat-context.util';

@Injectable()
export class WebhookFailureMonitorService {
    private readonly logger = createLogger(WebhookFailureMonitorService.name);

    private readonly thresholdPercent: number;
    private readonly windowMinutes: number;

    constructor(
        @InjectRepository(WorkflowJobModel)
        private readonly jobRepository: Repository<WorkflowJobModel>,
        private readonly incidentManager: IncidentManagerService,
        private readonly configService: ConfigService,
        private readonly distributedLockService: DistributedLockService,
    ) {
        this.thresholdPercent = this.configService.get<number>(
            'WEBHOOK_FAILURE_THRESHOLD_PERCENT',
            10,
        );
        this.windowMinutes = this.configService.get<number>(
            'WEBHOOK_FAILURE_WINDOW_MINUTES',
            30,
        );
    }

    @Cron('*/5 * * * *') // every 5 minutes
    async checkWebhookFailureRate(): Promise<void> {
        const lock = await this.acquireCronLock();
        if (!lock) {
            return;
        }

        try {
            const now = new Date();
            const since = new Date(
                now.getTime() - this.windowMinutes * 60 * 1000,
            );

            const result = await this.jobRepository
                .createQueryBuilder('job')
                .select(
                    "COUNT(*) FILTER (WHERE job.status = 'FAILED')",
                    'failed',
                )
                .addSelect(
                    "COUNT(*) FILTER (WHERE job.status IN ('COMPLETED', 'FAILED'))",
                    'total',
                )
                .where('job.workflowType = :type', {
                    type: WorkflowType.WEBHOOK_PROCESSING,
                })
                .andWhere('job.updatedAt >= :since', { since })
                .getRawOne();

            const failed = parseInt(result?.failed ?? '0', 10);
            const total = parseInt(result?.total ?? '0', 10);

            if (total === 0) {
                await this.incidentManager.pingHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_WEBHOOK_URL',
                );
                return;
            }

            const failureRate = (failed / total) * 100;

            if (failureRate >= this.thresholdPercent) {
                const breakdown = await this.getFailureBreakdown(since);
                const context = this.buildContext({
                    monitor: 'webhook_failure_rate',
                    windowStart: since,
                    windowEnd: now,
                    topErrors: breakdown.topErrors.join(' | '),
                    topPlatforms: breakdown.topPlatforms.join(' | '),
                    topEvents: breakdown.topEvents.join(' | '),
                    sampleJobIds: breakdown.sampleJobIds.join(','),
                    sampledFailures: breakdown.sampledFailures,
                });
                await this.incidentManager.failHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_WEBHOOK_URL',
                    `Webhook failure rate is ${failureRate.toFixed(1)}% (threshold: ${this.thresholdPercent}%) over the last ${this.windowMinutes} minutes. Failed: ${failed}, Total: ${total}.`,
                    context,
                );
            } else {
                await this.incidentManager.pingHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_WEBHOOK_URL',
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to check webhook failure rate',
                context: WebhookFailureMonitorService.name,
                error: error instanceof Error ? error : undefined,
                metadata: {
                    windowMinutes: this.windowMinutes,
                    thresholdPercent: this.thresholdPercent,
                },
            });
        } finally {
            await this.releaseCronLock(lock);
        }
    }

    private async getFailureBreakdown(since: Date): Promise<{
        topErrors: string[];
        topPlatforms: string[];
        topEvents: string[];
        sampleJobIds: string[];
        sampledFailures: number;
    }> {
        const failedJobs = await this.jobRepository
            .createQueryBuilder('job')
            .select('job.uuid', 'uuid')
            .addSelect('job.lastError', 'lastError')
            .addSelect(`job.metadata ->> 'platformType'`, 'platformType')
            .addSelect(`job.metadata ->> 'event'`, 'event')
            .where('job.workflowType = :type', {
                type: WorkflowType.WEBHOOK_PROCESSING,
            })
            .andWhere(`job.status = 'FAILED'`)
            .andWhere('job.updatedAt >= :since', { since })
            .orderBy('job.updatedAt', 'DESC')
            .limit(50)
            .getRawMany<{
                uuid: string;
                lastError?: string | null;
                platformType?: string | null;
                event?: string | null;
            }>();

        const summarize = (
            values: Array<string | null | undefined>,
            fallback: string,
        ): string[] => {
            const counts = new Map<string, number>();
            for (const value of values) {
                const normalized = value?.trim() || fallback;
                counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
            }

            return Array.from(counts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([value, count]) => `${value} (${count})`);
        };

        return {
            topErrors: summarize(
                failedJobs.map((job) => job.lastError),
                'unknown_error',
            ),
            topPlatforms: summarize(
                failedJobs.map((job) => job.platformType),
                'unknown_platform',
            ),
            topEvents: summarize(
                failedJobs.map((job) => job.event),
                'unknown_event',
            ),
            sampleJobIds: failedJobs
                .map((job) => job.uuid)
                .filter((uuid): uuid is string => !!uuid)
                .slice(0, 5),
            sampledFailures: failedJobs.length,
        };
    }

    private async acquireCronLock(): Promise<DistributedLock | null> {
        try {
            return await this.distributedLockService.acquire(
                'CRON:BETTERSTACK:WEBHOOK_FAILURE_MONITOR',
                { ttl: 4 * 60 * 1000 },
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to acquire webhook failure monitor lock',
                context: WebhookFailureMonitorService.name,
                error: error instanceof Error ? error : undefined,
            });
            return null;
        }
    }

    private async releaseCronLock(lock: DistributedLock | null): Promise<void> {
        if (!lock) {
            return;
        }

        try {
            await lock.release();
        } catch (error) {
            this.logger.error({
                message: 'Failed to release webhook failure monitor lock',
                context: WebhookFailureMonitorService.name,
                error: error instanceof Error ? error : undefined,
            });
        }
    }

    private buildContext(extra: Record<string, Date | number | string>) {
        return buildHeartbeatContext(
            this.configService.get<string>('API_NODE_ENV'),
            this.configService.get<string>('COMPONENT_TYPE', 'worker'),
            extra,
        );
    }
}
