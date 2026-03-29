import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createLogger } from '@kodus/flow';
import { MetricsEventModel } from './schemas/metrics-event.schema';
import { IncidentManagerService } from '../incident/incident-manager.service';
import { MetricsCollectorService } from './metrics-collector.service';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { buildHeartbeatContext } from '../incident/heartbeat-context.util';

@Injectable()
export class ReviewResponseMonitorService {
    private readonly logger = createLogger(ReviewResponseMonitorService.name);

    private readonly avgThresholdMs: number;
    private readonly avgCriticalMs: number;

    constructor(
        @InjectModel(MetricsEventModel.name)
        private readonly metricsModel: Model<MetricsEventModel>,
        private readonly incidentManager: IncidentManagerService,
        private readonly metricsCollector: MetricsCollectorService,
        private readonly configService: ConfigService,
        private readonly distributedLockService: DistributedLockService,
    ) {
        const legacyP95ThresholdMs = this.configService.get<number>(
            'REVIEW_RESPONSE_P95_THRESHOLD_MS',
            600_000,
        );
        const legacyP95CriticalMs = this.configService.get<number>(
            'REVIEW_RESPONSE_P95_CRITICAL_MS',
            1_200_000,
        );

        this.avgThresholdMs = this.configService.get<number>(
            'REVIEW_RESPONSE_AVG_THRESHOLD_MS',
            legacyP95ThresholdMs,
        );
        this.avgCriticalMs = this.configService.get<number>(
            'REVIEW_RESPONSE_AVG_CRITICAL_MS',
            legacyP95CriticalMs,
        );
    }

    @Cron('*/5 * * * *') // every 5 minutes
    async checkReviewResponseTimes(): Promise<void> {
        const lock = await this.acquireCronLock();
        if (!lock) {
            return;
        }

        try {
            const now = new Date();
            const since = new Date(now.getTime() - 30 * 60 * 1000); // last 30 minutes

            const results = await this.metricsModel
                .find({
                    name: 'code_review_duration_ms',
                    recordedAt: { $gte: since },
                })
                .select('value')
                .lean();

            if (results.length === 0) {
                // No reviews in window, but still ping to show monitor is alive
                await this.incidentManager.pingHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_REVIEW_MONITOR_URL',
                );
                return;
            }

            const values = results.map((r) => r.value).sort((a, b) => a - b);

            const p50 = this.percentile(values, 50);
            const p95 = this.percentile(values, 95);
            const avg = values.reduce((sum, v) => sum + v, 0) / values.length;

            this.metricsCollector.recordGauge(
                'review_response_p50_ms',
                p50,
                {},
            );
            this.metricsCollector.recordGauge(
                'review_response_p95_ms',
                p95,
                {},
            );
            this.metricsCollector.recordGauge(
                'review_response_avg_ms',
                avg,
                {},
            );

            if (avg >= this.avgThresholdMs) {
                const severity =
                    avg >= this.avgCriticalMs ? 'critical' : 'warning';

                const context = this.buildContext({
                    monitor: 'review_response_time',
                    windowStart: since,
                    windowEnd: now,
                    severity,
                    avg_ms: avg,
                    p50_ms: p50,
                    p95_ms: p95,
                    count: values.length,
                });

                await this.incidentManager.failHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_REVIEW_MONITOR_URL',
                    `Code review average response time is ${this.formatDuration(avg)} (${severity} threshold: ${this.formatDuration(this.avgThresholdMs)}, critical: ${this.formatDuration(this.avgCriticalMs)}). p50=${this.formatDuration(p50)}, p95=${this.formatDuration(p95)}, count=${values.length} in last 30 minutes.`,
                    context,
                );
            } else {
                await this.incidentManager.pingHeartbeat(
                    'API_BETTERSTACK_HEARTBEAT_REVIEW_MONITOR_URL',
                );
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to check review response times',
                context: ReviewResponseMonitorService.name,
                error: error instanceof Error ? error : undefined,
                metadata: {
                    avgThresholdMs: this.avgThresholdMs,
                },
            });
        } finally {
            await this.releaseCronLock(lock);
        }
    }

    private async acquireCronLock(): Promise<DistributedLock | null> {
        try {
            return await this.distributedLockService.acquire(
                'CRON:BETTERSTACK:REVIEW_RESPONSE_MONITOR',
                { ttl: 4 * 60 * 1000 },
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to acquire review response monitor lock',
                context: ReviewResponseMonitorService.name,
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
                message: 'Failed to release review response monitor lock',
                context: ReviewResponseMonitorService.name,
                error: error instanceof Error ? error : undefined,
            });
        }
    }

    private percentile(sortedValues: number[], p: number): number {
        if (sortedValues.length === 0) return 0;
        const index = Math.ceil((p / 100) * sortedValues.length) - 1;
        return sortedValues[Math.max(0, index)];
    }

    private formatDuration(ms: number): string {
        if (ms < 1000) return `${ms.toFixed(0)}ms`;
        if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
        return `${(ms / 60_000).toFixed(1)}min`;
    }

    private buildContext(extra: Record<string, Date | number | string>) {
        return buildHeartbeatContext(
            this.configService.get<string>('API_NODE_ENV'),
            this.configService.get<string>('COMPONENT_TYPE', 'worker'),
            extra,
        );
    }
}
