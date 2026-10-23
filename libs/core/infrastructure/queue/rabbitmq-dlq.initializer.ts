import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { createLogger } from '@libs/core/log/logger';
import { WORKFLOW_JOB_QUEUE_ARGUMENTS } from '@libs/core/workflow/infrastructure/workflow-queue-arguments';
import {
    Injectable,
    OnApplicationBootstrap,
    Optional,
} from '@nestjs/common';

type QueueBinding = {
    queue: string;
    routingKey: string;
};

// Queue ARGUMENTS deliberately live in WORKFLOW_JOB_QUEUE_ARGUMENTS (shared
// with the @RabbitSubscribe consumers) — a local copy here drifted from the
// consumers' args once already, and asserting a queue with divergent args
// closes the channel with 406 PRECONDITION_FAILED in an endless
// reconnect loop that unregisters every consumer.
const WORKFLOW_JOB_QUEUES: QueueBinding[] = [
    {
        queue: 'workflow.jobs.code_review.queue',
        routingKey: 'workflow.jobs.*.CODE_REVIEW',
    },
    {
        queue: 'workflow.jobs.cli_code_review.queue',
        routingKey: 'workflow.jobs.*.CLI_CODE_REVIEW',
    },
    {
        queue: 'workflow.jobs.webhook.queue',
        routingKey: 'workflow.jobs.*.WEBHOOK_PROCESSING',
    },
    {
        queue: 'workflow.jobs.check_implementation.queue',
        routingKey: 'workflow.jobs.*.CHECK_SUGGESTION_IMPLEMENTATION',
    },
    {
        queue: 'workflow.jobs.ast_graph_build.queue',
        routingKey: 'workflow.jobs.*.AST_GRAPH_BUILD',
    },
    {
        queue: 'workflow.jobs.ast_graph_incremental.queue',
        routingKey: 'workflow.jobs.*.AST_GRAPH_INCREMENTAL',
    },
];

@Injectable()
export class RabbitMQDLQInitializer implements OnApplicationBootstrap {
    private readonly logger = createLogger(RabbitMQDLQInitializer.name);
    /** True once delayed-exchanges / DLQ queues were asserted successfully. */
    private dlqReady = false;

    constructor(@Optional() private readonly amqpConnection?: AmqpConnection) {}

    // Run after every module has finished onModuleInit — including the
    // @RabbitSubscribe consumers that declare workflow.jobs.*.queue. Binding
    // before those declarations leaves the delayed exchange unbound (silent
    // loss of delayed retries), which is the race condition that produced
    // the NOT_FOUND errors on first boot with a fresh RabbitMQ volume.
    async onApplicationBootstrap(): Promise<void> {
        if (!this.amqpConnection) {
            this.logger.warn({
                message:
                    'RabbitMQ connection not available; skipping DLQ setup',
                context: RabbitMQDLQInitializer.name,
            });
            return;
        }

        const managedChannel: any = (this.amqpConnection as any).managedChannel;
        if (!managedChannel?.addSetup) {
            this.logger.warn({
                message:
                    'RabbitMQ managedChannel not available; skipping DLQ setup',
                context: RabbitMQDLQInitializer.name,
            });
            return;
        }

        // Eagerly declare delayed exchanges + queue bindings on startup.
        // addSetup is lazy (only runs on next connection), so we call
        // assertExchange/bindQueue directly to ensure everything exists
        // before any messages are published. The `.channel` getter throws
        // ChannelNotAvailableError when the connection is still
        // negotiating — treat that as "try again via addSetup below"
        // rather than crashing the bootstrap.
        let channel: any = null;
        try {
            channel = this.amqpConnection.channel;
        } catch (err) {
            this.logger.warn({
                message:
                    'RabbitMQ channel not ready at bootstrap; will set up on connect',
                context: RabbitMQDLQInitializer.name,
                error: err instanceof Error ? err : undefined,
            });
        }
        if (channel) {
            try {
                await this.declareDelayedExchanges(channel);
                await this.bindQueuesToDelayedExchange(channel);
                this.logger.log({
                    message:
                        'Delayed exchanges and queue bindings asserted eagerly',
                    context: RabbitMQDLQInitializer.name,
                });
            } catch (err) {
                this.logger.error({
                    message: 'Failed to assert delayed exchanges eagerly',
                    context: RabbitMQDLQInitializer.name,
                    error: err instanceof Error ? err : undefined,
                });
            }
        }

        // Also register the setup callback for connection re-establishments
        managedChannel.addSetup(async (setupChannel: any) => {
            try {
                await this.declareExchanges(setupChannel);
                await this.declareDLQQueues(setupChannel);
                await this.bindQueuesToDelayedExchange(setupChannel);

                this.dlqReady = true;
                this.logger.log({
                    message:
                        'DLQ queues/bindings and delayed exchanges asserted',
                    context: RabbitMQDLQInitializer.name,
                    metadata: { dlqReady: this.dlqReady },
                });
            } catch (err) {
                // amqp-connection-manager silently swallows setup errors. When
                // that happens the channel emits 'connect' but @RabbitSubscribe
                // handlers after this setup never register their consumers —
                // producing "channel connected, consumers=0" zombies. Root
                // cause of the 2026-04-24 incident.
                this.dlqReady = false;
                this.logger.error({
                    message:
                        'DLQ setup failed during (re)connect — consumers may NOT re-register',
                    context: RabbitMQDLQInitializer.name,
                    error: err instanceof Error ? err : undefined,
                    metadata: {
                        errorMessage:
                            err instanceof Error ? err.message : String(err),
                        dlqReady: this.dlqReady,
                    },
                });
                // Deliberately do NOT re-throw: an unhandledRejection here
                // aborts bootstrap before the HTTP server installs, turning a
                // recoverable DLQ-setup failure into a hard crash loop. The
                // dlqReady flag + error log above preserve visibility; the
                // next connection re-establishment retries the setup.
            }
        });

        if (typeof managedChannel.on === 'function') {
            managedChannel.on('error', (err: any, info: any) => {
                this.logger.error({
                    message: 'RabbitMQ managed channel error',
                    context: RabbitMQDLQInitializer.name,
                    error: err instanceof Error ? err : undefined,
                    metadata: {
                        errorMessage: err?.message,
                        channelName: info?.name,
                    },
                });
            });
        }
    }

    private async declareDelayedExchanges(channel: any): Promise<void> {
        await channel.assertExchange(
            'workflow.exchange.delayed',
            'x-delayed-message',
            {
                durable: true,
                arguments: { 'x-delayed-type': 'topic' },
            },
        );
        await channel.assertExchange(
            'workflow.events.delayed',
            'x-delayed-message',
            {
                durable: true,
                arguments: { 'x-delayed-type': 'topic' },
            },
        );
        await channel.assertExchange(
            'orchestrator.exchange.delayed',
            'x-delayed-message',
            {
                durable: true,
                arguments: { 'x-delayed-type': 'direct' },
            },
        );
    }

    private async declareExchanges(channel: any): Promise<void> {
        await channel.assertExchange('workflow.exchange.dlx', 'topic', {
            durable: true,
        });
        await channel.assertExchange('workflow.events.dlx', 'topic', {
            durable: true,
        });
        await channel.assertExchange('orchestrator.exchange.dlx', 'topic', {
            durable: true,
        });
        await this.declareDelayedExchanges(channel);
    }

    private async declareDLQQueues(channel: any): Promise<void> {
        await channel.assertQueue('workflow.jobs.dlq', {
            durable: true,
            arguments: { 'x-queue-type': 'quorum' },
        });
        await channel.bindQueue(
            'workflow.jobs.dlq',
            'workflow.exchange.dlx',
            '#',
        );

        await channel.assertQueue('workflow.events.dlq', {
            durable: true,
            arguments: { 'x-queue-type': 'quorum' },
        });
        await channel.bindQueue(
            'workflow.events.dlq',
            'workflow.events.dlx',
            '#',
        );

        await channel.assertQueue('orchestrator.dlq', {
            durable: true,
            arguments: { 'x-queue-type': 'quorum' },
        });
        await channel.bindQueue(
            'orchestrator.dlq',
            'orchestrator.exchange.dlx',
            '#',
        );
    }

    private async bindQueuesToDelayedExchange(channel: any): Promise<void> {
        for (const qb of WORKFLOW_JOB_QUEUES) {
            // Assert the queue with the SAME arguments @RabbitSubscribe uses
            // (single-sourced in WORKFLOW_JOB_QUEUE_ARGUMENTS) BEFORE
            // binding. A bind-only call assumes the @RabbitSubscribe consumer
            // already declared the queue on this channel — but on a fresh
            // RabbitMQ volume or a reconnect where the consumers haven't
            // re-declared yet, that race makes bindQueue fail with 404
            // NOT_FOUND. The binding is then silently lost (and in the
            // addSetup path the throw aborts consumer registration), so
            // CODE_REVIEW jobs are published to an unbound/absent queue and
            // the review never runs. Because the args are shared with the
            // consumers, assertQueue is idempotent — it creates the queue
            // when missing and is a no-op when the consumer already made it,
            // WITHOUT the PRECONDITION_FAILED that a divergent redeclare
            // would cause. This makes the initializer self-sufficient instead
            // of ordering-dependent.
            await channel.assertQueue(qb.queue, {
                durable: true,
                arguments: { ...WORKFLOW_JOB_QUEUE_ARGUMENTS[qb.queue] },
            });
            await channel.bindQueue(
                qb.queue,
                'workflow.exchange.delayed',
                qb.routingKey,
            );
        }
    }
}
