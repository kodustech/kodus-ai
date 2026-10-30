import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { createLogger } from '@libs/core/log/logger';
import { Injectable, OnApplicationShutdown, Optional } from '@nestjs/common';

const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;
const CANCEL_CONSUMERS_TIMEOUT_MS = 5_000;

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

        await this.cancelConsumers();

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

    /**
     * AmqpConnection.close() claims to cancel consumers first, but it does
     * so via ChannelWrapper.cancelAll(), which only knows consumers created
     * through the wrapper. golevelup (<= 9.1.0) creates @RabbitSubscribe
     * consumers on the raw amqplib channel inside addSetup, so cancelAll()
     * cancels nothing and a draining worker keeps taking new jobs until
     * SIGKILL. Cancel them explicitly through golevelup's own registry.
     *
     * Best-effort and bounded: the amqplib cancel RPC has no timeout, and a
     * half-open connection must not keep close() from running.
     */
    private async cancelConsumers(): Promise<void> {
        const timeoutMs = Math.min(CANCEL_CONSUMERS_TIMEOUT_MS, this.drainTimeoutMs);
        let timer: NodeJS.Timeout | undefined;
        let consumerCount: number | undefined;

        try {
            const consumerTags = this.amqpConnection?.consumerTags ?? [];
            consumerCount = consumerTags.length;

            const results = await Promise.race([
                Promise.allSettled(
                    consumerTags.map((tag) =>
                        this.amqpConnection!.cancelConsumer(tag),
                    ),
                ),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `Consumer cancel timeout after ${timeoutMs}ms`,
                                ),
                            ),
                        timeoutMs,
                    );
                }),
            ]);
            const failed = results.filter((r) => r.status === 'rejected').length;

            this.logger.log({
                message: 'Worker drain: RabbitMQ consumers cancelled',
                context: WorkerDrainService.name,
                metadata: { cancelled: consumerTags.length - failed, failed },
            });
        } catch (error) {
            this.logger.error({
                message:
                    'Worker drain: failed to cancel RabbitMQ consumers; closing anyway',
                context: WorkerDrainService.name,
                error: error instanceof Error ? error : undefined,
                // consumerCount stays undefined when reading the registry threw
                metadata: { timeoutMs, consumerCount },
            });
        } finally {
            clearTimeout(timer);
        }
    }
}
