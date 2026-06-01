import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { createLogger } from '@kodus/flow';
import {
    Injectable,
    OnApplicationBootstrap,
    Optional,
} from '@nestjs/common';

type QueueBinding = {
    queue: string;
    routingKey: string;
    queueArgs?: Record<string, any>;
};

const WORKFLOW_JOB_QUEUES: QueueBinding[] = [
    {
        queue: 'workflow.jobs.code_review.queue',
        routingKey: 'workflow.jobs.*.CODE_REVIEW',
        queueArgs: {
            'x-queue-type': 'quorum',
            'x-dead-letter-exchange': 'workflow.exchange.dlx',
            'x-dead-letter-routing-key': 'workflow.job.failed',
        },
    },
    {
        queue: 'workflow.jobs.cli_code_review.queue',
        routingKey: 'workflow.jobs.*.CLI_CODE_REVIEW',
        queueArgs: {
            'x-queue-type': 'quorum',
            'x-dead-letter-exchange': 'workflow.exchange.dlx',
            'x-dead-letter-routing-key': 'workflow.job.failed',
        },
    },
    {
        queue: 'workflow.jobs.webhook.queue',
        routingKey: 'workflow.jobs.*.WEBHOOK_PROCESSING',
        queueArgs: {
            'x-queue-type': 'quorum',
            'x-dead-letter-exchange': 'workflow.exchange.dlx',
            'x-dead-letter-routing-key': 'workflow.job.failed',
        },
    },
    {
        queue: 'workflow.jobs.check_implementation.queue',
        routingKey: 'workflow.jobs.*.CHECK_SUGGESTION_IMPLEMENTATION',
        queueArgs: {
            'x-queue-type': 'quorum',
            'x-dead-letter-exchange': 'workflow.exchange.dlx',
            'x-dead-letter-routing-key': 'workflow.job.failed',
        },
    },
    {
        queue: 'workflow.jobs.ast_graph_build.queue',
        routingKey: 'workflow.jobs.*.AST_GRAPH_BUILD',
        queueArgs: {
            'x-queue-type': 'quorum',
            'x-dead-letter-exchange': 'workflow.exchange.dlx',
            'x-dead-letter-routing-key': 'workflow.job.failed',
        },
    },
    {
        queue: 'workflow.jobs.ast_graph_incremental.queue',
        routingKey: 'workflow.jobs.*.AST_GRAPH_INCREMENTAL',
        queueArgs: {
            'x-queue-type': 'quorum',
            'x-dead-letter-exchange': 'workflow.exchange.dlx',
            'x-dead-letter-routing-key': 'workflow.job.failed',
        },
    },
];

@Injectable()
export class RabbitMQDLQInitializer implements OnApplicationBootstrap {
    private readonly logger = createLogger(RabbitMQDLQInitializer.name);

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

                this.logger.log({
                    message:
                        'DLQ queues/bindings and delayed exchanges asserted',
                    context: RabbitMQDLQInitializer.name,
                });
            } catch (err) {
                // amqp-connection-manager silently swallows setup errors. When
                // that happens the channel emits 'connect' but @RabbitSubscribe
                // handlers after this setup never register their consumers —
                // producing "channel connected, consumers=0" zombies. Root
                // cause of the 2026-04-24 incident.
                this.logger.error({
                    message:
                        'DLQ setup failed during (re)connect — consumers may NOT re-register',
                    context: RabbitMQDLQInitializer.name,
                    error: err instanceof Error ? err : undefined,
                    metadata: {
                        errorMessage:
                            err instanceof Error ? err.message : String(err),
                    },
                });
                throw err;
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
            // Only bind — do NOT assertQueue here because the queues are already
            // declared by @RabbitSubscribe with specific arguments (x-dead-letter-exchange,
            // x-queue-type, etc.). Re-declaring with different args closes the channel
            // with PRECONDITION_FAILED.
            await channel.bindQueue(
                qb.queue,
                'workflow.exchange.delayed',
                qb.routingKey,
            );
        }
    }
}
