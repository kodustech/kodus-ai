import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { createLogger } from '@libs/core/log/logger';
import { Injectable, OnApplicationShutdown, Optional } from '@nestjs/common';

const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;

function parseDrainTimeoutMs(): number {
    const raw = process.env.API_WORKER_DRAIN_TIMEOUT_MS;

    if (!raw) {
        return DEFAULT_DRAIN_TIMEOUT_MS;
    }
    const parsed = Number.parseInt(raw, 10);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_DRAIN_TIMEOUT_MS;
    }

    return parsed;
}

@Injectable()
export class WorkerDrainService implements OnApplicationShutdown {
    private readonly logger = createLogger(WorkerDrainService.name);
    private readonly drainTimeoutMs = parseDrainTimeoutMs();

    constructor(@Optional() private readonly amqpConnection?: AmqpConnection) {}

    async onApplicationShutdown(signal?: string): Promise<void> {
        if (!this.amqpConnection) {
            return;
        }

        this.logger.log({
            message: 'Worker drain: shutting down RabbitMQ consumers',
            context: WorkerDrainService.name,
            metadata: { signal, drainTimeoutMs: this.drainTimeoutMs },
        });

        try {
            // AmqpConnection.close():
            // - cancels all consumers (stop getting new messages)
            // - waits for outstanding message handlers to finish
            // - closes channels/connection
            await Promise.race([
                this.amqpConnection.close(),
                new Promise<void>((_, reject) =>
                    setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `Drain timeout after ${this.drainTimeoutMs}ms`,
                                ),
                            ),
                        this.drainTimeoutMs,
                    ),
                ),
            ]);

            this.logger.log({
                message: 'Worker drain: RabbitMQ consumers closed',
                context: WorkerDrainService.name,
            });
        } catch (error) {
            this.logger.error({
                message: 'Worker drain: failed to close RabbitMQ consumers',
                context: WorkerDrainService.name,
                error: error instanceof Error ? error : undefined,
            });
        }
    }
}
