import { Injectable, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { IJobStatusService } from '@libs/core/workflow/domain/contracts/job-status.service.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import {
    IInboxMessageRepository,
    INBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/inbox-message.repository.contract';
import {
    IOutboxMessageRepository,
    OUTBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';

import { WorkflowJobRepository } from './repositories/workflow-job.repository';
import { createLogger } from '@libs/core/log/logger';

@Injectable()
export class JobStatusService implements IJobStatusService {
    private readonly logger = createLogger(JobStatusService.name);

    constructor(
        private readonly jobRepository: WorkflowJobRepository,
        private readonly dataSource: DataSource,
        @Inject(INBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly inboxRepository: IInboxMessageRepository,
        @Inject(OUTBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly outboxRepository: IOutboxMessageRepository,
    ) {}

    async getJobStatus(jobId: string) {
        return await this.jobRepository.findOne(jobId);
    }

    async getJobDetail(jobId: string) {
        const job = await this.jobRepository.findOne(jobId);

        if (!job) {
            return null;
        }

        const executionHistory =
            await this.jobRepository.getExecutionHistory(jobId);

        return {
            job,
            executionHistory,
        };
    }

    async getMetrics() {
        // Fetch aggregate metrics from the database (workflow schema)
        const queueSize = await this.dataSource.query(
            `SELECT COUNT(*) as count FROM workflow.workflow_jobs WHERE status = $1`,
            [JobStatus.PENDING],
        );

        const processingCount = await this.dataSource.query(
            `SELECT COUNT(*) as count FROM workflow.workflow_jobs WHERE status = $1`,
            [JobStatus.PROCESSING],
        );

        const completedToday = await this.dataSource.query(
            `SELECT COUNT(*) as count FROM workflow.workflow_jobs
             WHERE status = $1 AND "completedAt" >= CURRENT_DATE`,
            [JobStatus.COMPLETED],
        );

        const failedToday = await this.dataSource.query(
            `SELECT COUNT(*) as count FROM workflow.workflow_jobs
             WHERE status = $1 AND "completedAt" >= CURRENT_DATE`,
            [JobStatus.FAILED],
        );

        const avgProcessingTime = await this.dataSource.query(
            `SELECT AVG(EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) * 1000) as avg_ms
             FROM workflow.workflow_jobs
             WHERE status = $1 AND "completedAt" IS NOT NULL AND "startedAt" IS NOT NULL
             AND "completedAt" >= CURRENT_DATE`,
            [JobStatus.COMPLETED],
        );

        const byStatus = await this.dataSource.query(
            `SELECT status, COUNT(*) as count
             FROM workflow.workflow_jobs
             GROUP BY status`,
        );

        const totalCompleted = parseInt(completedToday[0]?.count || '0');
        const totalFailed = parseInt(failedToday[0]?.count || '0');
        const total = totalCompleted + totalFailed;
        const successRate = total > 0 ? (totalCompleted / total) * 100 : 100;

        return {
            queueSize: parseInt(queueSize[0]?.count || '0'),
            processingCount: parseInt(processingCount[0]?.count || '0'),
            completedToday: totalCompleted,
            failedToday: totalFailed,
            averageProcessingTime: parseFloat(
                avgProcessingTime[0]?.avg_ms || '0',
            ),
            successRate,
            byStatus: byStatus.reduce(
                (acc: Record<string, number>, row: any) => {
                    acc[row.status] = parseInt(row.count);
                    return acc;
                },
                {},
            ),
        };
    }

    /**
     * Comprehensive health check for the entire workflow system
     * Includes inbox, outbox, and job metrics
     */
    async getWorkflowHealth(): Promise<{
        status: 'healthy' | 'degraded' | 'unhealthy';
        timestamp: Date;
        inbox: {
            ready: number;
            processing: number;
            processed: number;
            failed: number;
            oldestProcessing?: Date;
            oldestAge?: number; // minutes
        };
        outbox: {
            ready: number;
            processing: number;
            sent: number;
            failed: number;
        };
        jobs: {
            pending: number;
            processing: number;
            completed: number;
            failed: number;
        };
        alerts: string[];
    }> {
        const alerts: string[] = [];
        let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

        // Use Promise.allSettled to allow partial success
        const results = await Promise.allSettled([
            this.inboxRepository.getHealthStats(),
            this.getOutboxStats(),
            this.getJobStats(),
        ]);

        // Extract results with fallbacks
        const [inboxResult, outboxResult, jobResult] = results;

        // Default fallback values
        const defaultInbox: {
            ready: number;
            processing: number;
            processed: number;
            failed: number;
            oldestProcessing?: Date;
        } = {
            ready: 0,
            processing: 0,
            processed: 0,
            failed: 0,
        };
        const defaultOutbox = {
            ready: 0,
            processing: 0,
            sent: 0,
            failed: 0,
        };
        const defaultJobs = {
            pending: 0,
            processing: 0,
            completed: 0,
            failed: 0,
        };

        // Handle inbox metrics
        let inboxStats = defaultInbox;
        if (inboxResult.status === 'fulfilled') {
            inboxStats = inboxResult.value;
        } else {
            alerts.push('Inbox metrics unavailable');
            status = 'degraded';
            this.logger.error({
                message: 'Failed to get inbox health stats',
                context: JobStatusService.name,
                error: inboxResult.reason,
            });
        }

        // Handle outbox metrics
        let outboxStats = defaultOutbox;
        if (outboxResult.status === 'fulfilled') {
            outboxStats = outboxResult.value;
        } else {
            alerts.push('Outbox metrics unavailable');
            status = 'degraded';
            this.logger.error({
                message: 'Failed to get outbox stats',
                context: JobStatusService.name,
                error: outboxResult.reason,
            });
        }

        // Handle job metrics
        let jobStats = defaultJobs;
        if (jobResult.status === 'fulfilled') {
            jobStats = jobResult.value;
        } else {
            alerts.push('Job metrics unavailable');
            status = 'degraded';
            this.logger.error({
                message: 'Failed to get job stats',
                context: JobStatusService.name,
                error: jobResult.reason,
            });
        }

        // Check inbox health (only if metrics available)
        if (inboxResult.status === 'fulfilled') {
            if (inboxStats.processing > 100) {
                alerts.push(
                    `High inbox processing count: ${inboxStats.processing}`,
                );
                status = 'degraded';
            }

            if (inboxStats.oldestProcessing) {
                const oldestAge = Math.floor(
                    (Date.now() - inboxStats.oldestProcessing.getTime()) /
                        60000,
                );
                if (oldestAge > 60) {
                    alerts.push(
                        `Oldest inbox message: ${oldestAge} minutes old`,
                    );
                    status = 'degraded';
                }
                if (oldestAge > 180) {
                    status = 'unhealthy';
                }
            }
        }

        // Check outbox health (only if metrics available)
        if (outboxResult.status === 'fulfilled') {
            if (outboxStats.ready > 500) {
                alerts.push(`High outbox queue: ${outboxStats.ready} messages`);
                status = status === 'unhealthy' ? 'unhealthy' : 'degraded';
            }
        }

        // Check job health (only if metrics available)
        if (jobResult.status === 'fulfilled') {
            if (jobStats.failed > 50) {
                alerts.push(`High job failure count: ${jobStats.failed}`);
                status = 'degraded';
            }
        }

        // If all metrics failed, mark as unhealthy
        if (
            inboxResult.status === 'rejected' &&
            outboxResult.status === 'rejected' &&
            jobResult.status === 'rejected'
        ) {
            status = 'unhealthy';
        }

        return {
            status,
            timestamp: new Date(),
            inbox: {
                ...inboxStats,
                oldestAge: inboxStats.oldestProcessing
                    ? Math.floor(
                          (Date.now() - inboxStats.oldestProcessing.getTime()) /
                              60000,
                      )
                    : undefined,
            },
            outbox: outboxStats,
            jobs: jobStats,
            alerts,
        };
    }

    private async getOutboxStats(): Promise<{
        ready: number;
        processing: number;
        sent: number;
        failed: number;
    }> {
        const result = await this.dataSource.query(
            `SELECT status, COUNT(*) as count
             FROM kodus_workflow.outbox_messages
             GROUP BY status`,
        );

        const stats = { ready: 0, processing: 0, sent: 0, failed: 0 };
        result.forEach((row: { status: string; count: string }) => {
            const count = parseInt(row.count);
            switch (row.status) {
                case 'READY':
                    stats.ready = count;
                    break;
                case 'PROCESSING':
                    stats.processing = count;
                    break;
                case 'SENT':
                    stats.sent = count;
                    break;
                case 'FAILED':
                    stats.failed = count;
                    break;
            }
        });

        return stats;
    }

    private async getJobStats(): Promise<{
        pending: number;
        processing: number;
        completed: number;
        failed: number;
    }> {
        const result = await this.dataSource.query(
            `SELECT status, COUNT(*) as count
             FROM kodus_workflow.workflow_jobs
             WHERE "createdAt" > NOW() - INTERVAL '24 hours'
             GROUP BY status`,
        );

        const stats = { pending: 0, processing: 0, completed: 0, failed: 0 };
        result.forEach((row: { status: string; count: string }) => {
            const count = parseInt(row.count);
            switch (row.status) {
                case 'PENDING':
                    stats.pending = count;
                    break;
                case 'PROCESSING':
                    stats.processing = count;
                    break;
                case 'COMPLETED':
                    stats.completed = count;
                    break;
                case 'FAILED':
                    stats.failed = count;
                    break;
            }
        });

        return stats;
    }
}
