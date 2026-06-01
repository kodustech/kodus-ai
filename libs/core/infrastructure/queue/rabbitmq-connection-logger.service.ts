import * as os from 'os';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { createLogger } from '@kodus/flow';
import {
    Injectable,
    OnModuleDestroy,
    OnModuleInit,
    Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelWrapper } from 'amqp-connection-manager';

type ManagedConnection = {
    on: (event: string, handler: (...args: any[]) => void) => void;
    off?: (event: string, handler: (...args: any[]) => void) => void;
    removeListener?: (event: string, handler: (...args: any[]) => void) => void;
};

@Injectable()
export class RabbitMQConnectionLoggerService
    implements OnModuleInit, OnModuleDestroy
{
    private readonly logger = createLogger(
        RabbitMQConnectionLoggerService.name,
    );
    private readonly componentType: string;
    private readonly instanceId = os.hostname();
    private managedConnection?: ManagedConnection;
    private readonly channelCleanups: Array<() => void> = [];
    private connectHandler?: (args: { connection?: unknown }) => void;
    private disconnectHandler?: (args: { err?: Error }) => void;
    private connectFailedHandler?: (args: { err?: Error }) => void;
    private blockedHandler?: (args: { reason?: string }) => void;
    private unblockedHandler?: () => void;

    constructor(
        private readonly configService: ConfigService,
        @Optional() private readonly amqpConnection?: AmqpConnection,
    ) {
        this.componentType = this.configService.get<string>(
            'COMPONENT_TYPE',
            'unknown',
        );
    }

    onModuleInit(): void {
        if (!this.amqpConnection) {
            this.logger.debug({
                message:
                    'RabbitMQ connection not available; skipping listeners',
                context: RabbitMQConnectionLoggerService.name,
                metadata: {
                    component: this.componentType,
                    instanceId: this.instanceId,
                },
            });
            return;
        }

        this.attachConnectionListeners();
        this.attachChannelListeners();
    }

    // ───────────────── Connection-level listeners ─────────────────

    private attachConnectionListeners(): void {
        const managedConnection = (this.amqpConnection as any)
            .managedConnection as ManagedConnection | undefined;

        if (!managedConnection || typeof managedConnection.on !== 'function') {
            this.logger.debug({
                message:
                    'RabbitMQ managedConnection not available; skipping listeners',
                context: RabbitMQConnectionLoggerService.name,
                metadata: {
                    component: this.componentType,
                    instanceId: this.instanceId,
                },
            });
            return;
        }

        this.managedConnection = managedConnection;

        this.connectHandler = () => {
            this.logger.log({
                message: 'RabbitMQ connected',
                context: RabbitMQConnectionLoggerService.name,
                metadata: {
                    component: this.componentType,
                    instanceId: this.instanceId,
                    connectionName: this.amqpConnection?.configuration?.name,
                },
            });
        };

        this.disconnectHandler = ({ err }) => {
            this.logger.error({
                message: 'RabbitMQ disconnected',
                context: RabbitMQConnectionLoggerService.name,
                error: err,
                metadata: {
                    component: this.componentType,
                    instanceId: this.instanceId,
                    connectionName: this.amqpConnection?.configuration?.name,
                    errorMessage: err?.message,
                },
            });
        };

        this.connectFailedHandler = ({ err }) => {
            this.logger.warn({
                message: 'RabbitMQ connection failed',
                context: RabbitMQConnectionLoggerService.name,
                error: err,
                metadata: {
                    component: this.componentType,
                    instanceId: this.instanceId,
                    connectionName: this.amqpConnection?.configuration?.name,
                    errorMessage: err?.message,
                },
            });
        };

        // connection.blocked / unblocked: broker-level resource alarms
        // (memory/disk pressure). When blocked, publishes are paused and
        // consumers can stall — worth surfacing so we can correlate with
        // prod incidents instead of guessing.
        this.blockedHandler = ({ reason }) => {
            this.logger.warn({
                message: 'RabbitMQ broker blocked publishers',
                context: RabbitMQConnectionLoggerService.name,
                metadata: {
                    component: this.componentType,
                    instanceId: this.instanceId,
                    reason,
                },
            });
        };

        this.unblockedHandler = () => {
            this.logger.log({
                message: 'RabbitMQ broker unblocked publishers',
                context: RabbitMQConnectionLoggerService.name,
                metadata: {
                    component: this.componentType,
                    instanceId: this.instanceId,
                },
            });
        };

        managedConnection.on('connect', this.connectHandler);
        managedConnection.on('disconnect', this.disconnectHandler);
        managedConnection.on('connectFailed', this.connectFailedHandler);
        managedConnection.on('blocked', this.blockedHandler);
        managedConnection.on('unblocked', this.unblockedHandler);
    }

    // ───────────────── Channel-level listeners ─────────────────

    private attachChannelListeners(): void {
        const managedChannels = this.amqpConnection?.managedChannels;
        if (!managedChannels) return;

        for (const [name, wrapper] of Object.entries(managedChannels)) {
            const cw: ChannelWrapper = wrapper;
            if (!cw || typeof cw.on !== 'function') continue;

            const onConnect = () => {
                const consumerCount = Array.isArray((cw as any)._consumers)
                    ? (cw as any)._consumers.length
                    : 'unknown';
                this.logger.log({
                    message: `RabbitMQ channel "${name}" connected`,
                    context: RabbitMQConnectionLoggerService.name,
                    metadata: {
                        component: this.componentType,
                        instanceId: this.instanceId,
                        channel: name,
                        consumers: consumerCount,
                    },
                });
            };

            const onClose = () => {
                this.logger.error({
                    message: `RabbitMQ channel "${name}" closed`,
                    context: RabbitMQConnectionLoggerService.name,
                    metadata: {
                        component: this.componentType,
                        instanceId: this.instanceId,
                        channel: name,
                        connectionAlive:
                            this.amqpConnection?.connected ?? false,
                        zombieRisk:
                            (this.amqpConnection?.connected ?? false) === true,
                    },
                });
            };

            const onError = (err: Error, info?: { name?: string }) => {
                this.logger.error({
                    message: `RabbitMQ channel "${name}" error: ${err?.message}`,
                    context: RabbitMQConnectionLoggerService.name,
                    error: err,
                    metadata: {
                        component: this.componentType,
                        instanceId: this.instanceId,
                        channel: name,
                        channelInfo: info,
                        errorName: err?.name,
                        errorMessage: err?.message,
                        connectionAlive:
                            this.amqpConnection?.connected ?? false,
                    },
                });
            };

            cw.on('connect', onConnect);
            cw.on('close', onClose);
            cw.on('error', onError);

            // Store cleanup functions for onModuleDestroy.
            this.channelCleanups.push(() => {
                cw.removeListener('connect', onConnect);
                cw.removeListener('close', onClose);
                cw.removeListener('error', onError);
            });
        }

        const channelNames = Object.keys(managedChannels);
        this.logger.log({
            message: `Attached listeners to ${channelNames.length} managed channels`,
            context: RabbitMQConnectionLoggerService.name,
            metadata: {
                component: this.componentType,
                instanceId: this.instanceId,
                channels: channelNames,
            },
        });
    }

    // ───────────────── Cleanup ─────────────────

    onModuleDestroy(): void {
        // Connection listeners.
        if (this.managedConnection) {
            const off =
                this.managedConnection.off?.bind(this.managedConnection) ||
                this.managedConnection.removeListener?.bind(
                    this.managedConnection,
                );

            if (off) {
                if (this.connectHandler) off('connect', this.connectHandler);
                if (this.disconnectHandler)
                    off('disconnect', this.disconnectHandler);
                if (this.connectFailedHandler)
                    off('connectFailed', this.connectFailedHandler);
                if (this.blockedHandler) off('blocked', this.blockedHandler);
                if (this.unblockedHandler)
                    off('unblocked', this.unblockedHandler);
            }
        }

        // Channel listeners.
        for (const cleanup of this.channelCleanups) {
            try {
                cleanup();
            } catch {
                // Best-effort cleanup.
            }
        }
        this.channelCleanups.length = 0;
    }
}
