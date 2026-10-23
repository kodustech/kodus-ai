import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { createLogger } from '@libs/core/log/logger';
import { Injectable, OnApplicationBootstrap, Optional } from '@nestjs/common';

import { declareRetryTopology } from './config/rabbitmq-retry-topology';

@Injectable()
export class RabbitMQDLQInitializer implements OnApplicationBootstrap {
    private readonly logger = createLogger(RabbitMQDLQInitializer.name);

    constructor(@Optional() private readonly amqpConnection?: AmqpConnection) {}

    // Run after every module has finished onModuleInit, so the base
    // exchanges the retry path returns to were already declared.
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

        // Eagerly declare the retry path on startup: a retry published before
        // its wait queue exists is unroutable and dropped. The `.channel` getter throws
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
                await declareRetryTopology(channel);
                this.logger.log({
                    message: 'Retry wait queues and bindings asserted eagerly',
                    context: RabbitMQDLQInitializer.name,
                });
            } catch (err) {
                this.logger.error({
                    message: 'Failed to assert the retry path eagerly',
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
                await declareRetryTopology(setupChannel);

                this.logger.log({
                    message: 'DLQ queues/bindings and retry path asserted',
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
}
