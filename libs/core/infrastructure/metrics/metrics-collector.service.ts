import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createLogger } from '@libs/core/log/logger';
import { MetricsEventModel } from './schemas/metrics-event.schema';
import { MetricType, MetricEvent } from './interfaces/metrics.interfaces';

@Injectable()
export class MetricsCollectorService implements OnModuleDestroy {
    private readonly logger = createLogger(MetricsCollectorService.name);
    private buffer: MetricEvent[] = [];
    private flushTimer: ReturnType<typeof setInterval> | null = null;

    private static readonly BATCH_SIZE = 75;
    private static readonly FLUSH_INTERVAL_MS = 5_000;

    constructor(
        @InjectModel(MetricsEventModel.name)
        private readonly metricsModel: Model<MetricsEventModel>,
    ) {
        this.flushTimer = setInterval(
            () => this.flush(),
            MetricsCollectorService.FLUSH_INTERVAL_MS,
        );
    }

    async onModuleDestroy(): Promise<void> {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flush();
    }

    recordCounter(
        name: string,
        value: number,
        labels: Record<string, string> = {},
    ): void {
        this.addToBuffer({
            name,
            type: MetricType.COUNTER,
            value,
            labels,
            recordedAt: new Date(),
        });
    }

    recordHistogram(
        name: string,
        valueMs: number,
        labels: Record<string, string> = {},
    ): void {
        this.addToBuffer({
            name,
            type: MetricType.HISTOGRAM,
            value: valueMs,
            labels,
            recordedAt: new Date(),
        });
    }

    recordGauge(
        name: string,
        value: number,
        labels: Record<string, string> = {},
    ): void {
        this.addToBuffer({
            name,
            type: MetricType.GAUGE,
            value,
            labels,
            recordedAt: new Date(),
        });
    }

    private addToBuffer(event: MetricEvent): void {
        this.buffer.push(event);

        if (this.buffer.length >= MetricsCollectorService.BATCH_SIZE) {
            this.flush().catch((err) => {
                this.logger.error({
                    message:
                        'Failed to flush metrics buffer on batch size trigger',
                    context: MetricsCollectorService.name,
                    error: err instanceof Error ? err : undefined,
                });
            });
        }
    }

    private async flush(): Promise<void> {
        if (this.buffer.length === 0) {
            return;
        }

        const batch = this.buffer.splice(0);

        try {
            await this.metricsModel.insertMany(batch, { ordered: false });
        } catch (error) {
            this.logger.error({
                message: `Failed to flush ${batch.length} metrics to MongoDB`,
                context: MetricsCollectorService.name,
                error: error instanceof Error ? error : undefined,
                metadata: { batchSize: batch.length },
            });
        }
    }
}
