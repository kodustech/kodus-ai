import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { createLogger } from '@libs/core/log/logger';
import {
    Injectable,
    OnApplicationShutdown,
    OnModuleDestroy,
    Optional,
} from '@nestjs/common';

const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;
/**
 * The drain budget sizes the health guard's force-exit timer. Node clamps a
 * timer above 2^31-1 ms to ~1 ms, so an extra zero would force-exit at once,
 * mid-drain; ten minutes is far above prod's 240s.
 */
export const MAX_DRAIN_TIMEOUT_MS = 10 * 60_000;
const CANCEL_CONSUMERS_TIMEOUT_MS = 5_000;
/**
 * The connection closes after the job drain, so no handler should still be
 * running; close() only has to flush acks and tear channels down.
 */
const CLOSE_CONNECTION_TIMEOUT_MS = 15_000;

/**
 * Longest the shutdown can take after the job drain budget: a consumer
 * cancel in each hook (the second only retries what the first missed) and
 * the connection close. The health guard's force-exit adds this on top of
 * the drain budget, so it never fires mid-close.
 */
export const SHUTDOWN_AFTER_DRAIN_MS =
    2 * CANCEL_CONSUMERS_TIMEOUT_MS + CLOSE_CONNECTION_TIMEOUT_MS;

export function parseDrainTimeoutMs(): number {
    const raw = process.env.API_WORKER_DRAIN_TIMEOUT_MS;

    if (!raw) {
        return DEFAULT_DRAIN_TIMEOUT_MS;
    }
    const parsed = Number.parseInt(raw, 10);

    if (
        !Number.isFinite(parsed) ||
        parsed <= 0 ||
        parsed > MAX_DRAIN_TIMEOUT_MS
    ) {
        createLogger('WorkerDrainService').warn({
            message:
                'API_WORKER_DRAIN_TIMEOUT_MS is out of range; using the default',
            context: 'WorkerDrainService',
            metadata: {
                configured: raw,
                max: MAX_DRAIN_TIMEOUT_MS,
                default: DEFAULT_DRAIN_TIMEOUT_MS,
            },
        });
        return DEFAULT_DRAIN_TIMEOUT_MS;
    }

    return parsed;
}

/**
 * Shutdown order (Nest runs every phase root module first, and this service
 * lives in the root WorkerModule):
 *
 * 1. onModuleDestroy (this service, first hook of the whole shutdown):
 *    cancel every RabbitMQ consumer, so the worker stops taking messages
 *    before anything else starts winding down.
 * 2. beforeApplicationShutdown (WorkflowJobConsumer): wait for the active
 *    jobs, then release this host's inbox locks.
 * 3. onApplicationShutdown (this service): close the AMQP connection. Only
 *    now, so jobs that were still running could ack their messages instead
 *    of having them redelivered to other workers mid-run.
 */
@Injectable()
export class WorkerDrainService
    implements OnModuleDestroy, OnApplicationShutdown
{
    private readonly logger = createLogger(WorkerDrainService.name);
    private readonly drainTimeoutMs = parseDrainTimeoutMs();
    /** Tags whose cancel succeeded; a later call retries only the rest. */
    private readonly cancelledTags = new Set<string>();

    constructor(@Optional() private readonly amqpConnection?: AmqpConnection) {}

    async onModuleDestroy(): Promise<void> {
        if (!this.amqpConnection) {
            return;
        }

        this.logger.log({
            message: 'Worker drain: cancelling RabbitMQ consumers',
            context: WorkerDrainService.name,
            metadata: { drainTimeoutMs: this.drainTimeoutMs },
        });

        await this.cancelConsumers();
    }

    async onApplicationShutdown(signal?: string): Promise<void> {
        if (!this.amqpConnection) {
            return;
        }

        this.logger.log({
            message: 'Worker drain: closing RabbitMQ connection',
            context: WorkerDrainService.name,
            metadata: { signal, drainTimeoutMs: this.drainTimeoutMs },
        });

        // app.close() without a destroy phase (or a failed one) still must
        // not close the connection with live consumers.
        await this.cancelConsumers();

        let timer: NodeJS.Timeout | undefined;
        try {
            // AmqpConnection.close() waits for outstanding message handlers,
            // then closes channels and the connection. The jobs already
            // drained in beforeApplicationShutdown, so this gets a short
            // budget of its own, not a second drain budget.
            await Promise.race([
                this.amqpConnection.close(),
                new Promise<void>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `Connection close timeout after ${CLOSE_CONNECTION_TIMEOUT_MS}ms`,
                                ),
                            ),
                        CLOSE_CONNECTION_TIMEOUT_MS,
                    );
                }),
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
        } finally {
            clearTimeout(timer);
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
     * half-open connection must not keep close() from running. A tag whose
     * cancel failed or timed out stays pending, so the call in
     * onApplicationShutdown retries it (and any consumer a recreated channel
     * registered meanwhile) instead of closing with live consumers.
     */
    private async cancelConsumers(): Promise<void> {
        const timeoutMs = Math.min(
            CANCEL_CONSUMERS_TIMEOUT_MS,
            this.drainTimeoutMs,
        );
        let timer: NodeJS.Timeout | undefined;
        let consumerCount: number | undefined;

        try {
            const consumerTags = (
                this.amqpConnection?.consumerTags ?? []
            ).filter((tag) => !this.cancelledTags.has(tag));
            consumerCount = consumerTags.length;
            if (!consumerTags.length) return;

            const results = await Promise.race([
                Promise.allSettled(
                    consumerTags.map(async (tag) => {
                        await this.amqpConnection!.cancelConsumer(tag);
                        this.cancelledTags.add(tag);
                    }),
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
            const failed = results.filter(
                (r) => r.status === 'rejected',
            ).length;

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
