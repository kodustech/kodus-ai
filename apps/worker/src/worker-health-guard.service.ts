import * as os from 'os';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { createLogger } from '@kodus/flow';
import {
    Injectable,
    OnApplicationBootstrap,
    OnApplicationShutdown,
    Optional,
} from '@nestjs/common';

/**
 * Guarantees that a running worker always has active RabbitMQ consumers.
 *
 * ## Why this exists
 *
 * amqp-connection-manager has a critical gap: when the broker closes a
 * **channel** (e.g. consumer_timeout → PRECONDITION_FAILED), the
 * ChannelWrapper sets `_channel = undefined` and waits for the
 * **connection** to reconnect. But the connection is still alive, so
 * nothing ever triggers channel re-creation. The consumer silently
 * disappears and the worker becomes a zombie.
 *
 * ## How it works
 *
 * 1. **Startup assertion** — waits for all managed channels to connect.
 *    If any channel fails within BOOT_TIMEOUT_MS, exits.
 *
 * 2. **Event-driven channel monitoring** — listens for `close` and
 *    `error` events on each managed channel. On close, attempts to
 *    force reconnect. If channels stay dead after MAX_CHANNEL_DEAD_MS,
 *    initiates graceful shutdown.
 *
 * 3. **Periodic health check** — safety net that polls channel state
 *    in case events were missed.
 */
@Injectable()
export class WorkerHealthGuardService
    implements OnApplicationBootstrap, OnApplicationShutdown
{
    private readonly logger = createLogger(WorkerHealthGuardService.name);
    private readonly instanceId = os.hostname();

    private readonly BOOT_TIMEOUT_MS = 30_000;
    private readonly CHECK_INTERVAL_MS = 30_000;
    private readonly MAX_CHANNEL_DEAD_MS = 90_000;
    private readonly MAX_DISCONNECT_MS = 120_000;

    private checkTimer?: ReturnType<typeof setInterval>;
    private disconnectedSince?: number;
    private deadChannelsSince?: number;
    private isShuttingDown = false;

    constructor(
        @Optional() private readonly amqpConnection?: AmqpConnection,
    ) {}

    // ───────────────────── Startup assertion ─────────────────────

    async onApplicationBootstrap(): Promise<void> {
        if (!this.amqpConnection) {
            this.logger.warn({
                message: 'No AmqpConnection — RabbitMQ disabled, skipping health guard.',
                context: WorkerHealthGuardService.name,
                metadata: { instanceId: this.instanceId },
            });
            return;
        }

        const expectedChannels = this.getExpectedChannelNames();

        this.logger.log({
            message: `Waiting up to ${this.BOOT_TIMEOUT_MS}ms for ${expectedChannels.length} channels...`,
            context: WorkerHealthGuardService.name,
            metadata: { instanceId: this.instanceId, expectedChannels },
        });

        const managedChannels = this.amqpConnection.managedChannels;
        const missing = expectedChannels.filter((name) => !managedChannels[name]);

        if (missing.length > 0) {
            this.logger.error({
                message: `Managed channels not registered: ${missing.join(', ')}. Exiting.`,
                context: WorkerHealthGuardService.name,
                metadata: {
                    instanceId: this.instanceId,
                    expected: expectedChannels,
                    found: Object.keys(managedChannels),
                    missing,
                },
            });
            this.exitGracefully(1);
            return;
        }

        // Wait for each channel to connect.
        const timeout = new Promise<never>((_, reject) =>
            setTimeout(
                () => reject(new Error(`Boot timeout after ${this.BOOT_TIMEOUT_MS}ms`)),
                this.BOOT_TIMEOUT_MS,
            ),
        );

        try {
            await Promise.race([
                Promise.all(
                    expectedChannels.map((name) =>
                        managedChannels[name].waitForConnect(),
                    ),
                ),
                timeout,
            ]);
        } catch (error) {
            this.logger.error({
                message: `Channels failed to connect on boot. Exiting.`,
                context: WorkerHealthGuardService.name,
                error: error instanceof Error ? error : undefined,
                metadata: { instanceId: this.instanceId },
            });
            this.exitGracefully(1);
            return;
        }

        this.logger.log({
            message: `All ${expectedChannels.length} channels connected. Attaching listeners.`,
            context: WorkerHealthGuardService.name,
            metadata: { instanceId: this.instanceId },
        });

        // Attach event listeners on each channel for immediate detection.
        this.attachChannelListeners(expectedChannels);

        // Periodic safety net.
        this.checkTimer = setInterval(
            () => this.checkHealth(),
            this.CHECK_INTERVAL_MS,
        );
    }

    // ───────────────── Event-driven channel monitoring ─────────────────

    private attachChannelListeners(channelNames: string[]): void {
        const managedChannels = this.amqpConnection!.managedChannels;

        for (const name of channelNames) {
            const wrapper = managedChannels[name];
            if (!wrapper) continue;

            wrapper.on('close', () => {
                if (this.isShuttingDown) return;

                this.logger.error({
                    message: `Channel "${name}" closed unexpectedly.`,
                    context: WorkerHealthGuardService.name,
                    metadata: {
                        instanceId: this.instanceId,
                        channel: name,
                        connectionAlive: this.amqpConnection?.connected,
                    },
                });

                this.handleChannelDeath(name);
            });

            wrapper.on('error', (err: Error, info?: { name?: string }) => {
                this.logger.error({
                    message: `Channel "${name}" error: ${err?.message}`,
                    context: WorkerHealthGuardService.name,
                    error: err,
                    metadata: {
                        instanceId: this.instanceId,
                        channel: name,
                        channelInfo: info,
                        connectionAlive: this.amqpConnection?.connected,
                    },
                });
            });

            // Log connect events for visibility.
            wrapper.on('connect', () => {
                this.logger.log({
                    message: `Channel "${name}" connected.`,
                    context: WorkerHealthGuardService.name,
                    metadata: {
                        instanceId: this.instanceId,
                        channel: name,
                    },
                });
            });
        }
    }

    private handleChannelDeath(channelName: string): void {
        if (!this.amqpConnection?.connected) {
            // Connection is down — amqp-connection-manager will handle
            // reconnect and re-create channels. No action needed here.
            this.logger.warn({
                message: `Channel "${channelName}" died but connection is also down. Waiting for connection-level reconnect.`,
                context: WorkerHealthGuardService.name,
                metadata: { instanceId: this.instanceId },
            });
            return;
        }

        // Connection alive + channel dead = the zombie bug.
        // Try to force reconnect so amqp-connection-manager re-creates channels.
        this.logger.warn({
            message: `Zombie state: connection alive but channel "${channelName}" dead. Forcing reconnect...`,
            context: WorkerHealthGuardService.name,
            metadata: { instanceId: this.instanceId, channel: channelName },
        });

        try {
            const managedConnection = (this.amqpConnection as any).managedConnection;
            if (managedConnection && typeof managedConnection.reconnect === 'function') {
                managedConnection.reconnect();
                this.logger.log({
                    message: 'Forced reconnect triggered.',
                    context: WorkerHealthGuardService.name,
                    metadata: { instanceId: this.instanceId },
                });
            }
        } catch (err) {
            this.logger.error({
                message: 'Failed to force reconnect.',
                context: WorkerHealthGuardService.name,
                error: err instanceof Error ? err : undefined,
                metadata: { instanceId: this.instanceId },
            });
        }

        // Start the dead-channel timer. If channels don't recover within
        // MAX_CHANNEL_DEAD_MS, the periodic check will trigger exit.
        if (!this.deadChannelsSince) {
            this.deadChannelsSince = Date.now();
        }
    }

    // ───────────────── Periodic health check (safety net) ─────────────────

    private checkHealth(): void {
        if (!this.amqpConnection || this.isShuttingDown) return;

        const connectionAlive = this.amqpConnection.connected;

        // ── Connection-level check ──
        if (!connectionAlive) {
            this.deadChannelsSince = undefined;

            if (!this.disconnectedSince) {
                this.disconnectedSince = Date.now();
                this.logger.warn({
                    message: 'AMQP connection lost.',
                    context: WorkerHealthGuardService.name,
                    metadata: {
                        instanceId: this.instanceId,
                        maxDisconnectMs: this.MAX_DISCONNECT_MS,
                    },
                });
                return;
            }

            const downMs = Date.now() - this.disconnectedSince;
            if (downMs >= this.MAX_DISCONNECT_MS) {
                this.logger.error({
                    message: `AMQP disconnected for ${Math.round(downMs / 1000)}s. Exiting.`,
                    context: WorkerHealthGuardService.name,
                    metadata: { instanceId: this.instanceId, downMs },
                });
                this.exitGracefully(1);
                return;
            }
            return;
        }

        // Connection alive — reset.
        if (this.disconnectedSince) {
            const downMs = Date.now() - this.disconnectedSince;
            this.logger.log({
                message: `AMQP connection restored after ${Math.round(downMs / 1000)}s.`,
                context: WorkerHealthGuardService.name,
                metadata: { instanceId: this.instanceId },
            });
            this.disconnectedSince = undefined;
        }

        // ── Channel-level check (zombie detector) ──
        const channelStatus = this.getChannelStatus();

        if (channelStatus.dead.length === 0) {
            if (this.deadChannelsSince) {
                this.logger.log({
                    message: 'All channels recovered.',
                    context: WorkerHealthGuardService.name,
                    metadata: {
                        instanceId: this.instanceId,
                        channels: channelStatus.alive,
                        consumers: channelStatus.consumers,
                    },
                });
                this.deadChannelsSince = undefined;
            }
            return;
        }

        // Dead channels detected.
        if (!this.deadChannelsSince) {
            this.deadChannelsSince = Date.now();
            this.logger.warn({
                message: `Dead channels while connection alive: ${channelStatus.dead.join(', ')}`,
                context: WorkerHealthGuardService.name,
                metadata: {
                    instanceId: this.instanceId,
                    deadChannels: channelStatus.dead,
                    aliveChannels: channelStatus.alive,
                    consumers: channelStatus.consumers,
                    maxChannelDeadMs: this.MAX_CHANNEL_DEAD_MS,
                },
            });

            // Try force reconnect on first detection.
            this.handleChannelDeath(channelStatus.dead[0]);
            return;
        }

        const deadMs = Date.now() - this.deadChannelsSince;
        if (deadMs >= this.MAX_CHANNEL_DEAD_MS) {
            this.logger.error({
                message: `Channels dead for ${Math.round(deadMs / 1000)}s despite reconnect attempt. Exiting.`,
                context: WorkerHealthGuardService.name,
                metadata: {
                    instanceId: this.instanceId,
                    deadChannels: channelStatus.dead,
                    deadMs,
                },
            });
            this.exitGracefully(1);
            return;
        }

        this.logger.warn({
            message: `Channels still dead: ${channelStatus.dead.join(', ')} (${Math.round(deadMs / 1000)}s / ${this.MAX_CHANNEL_DEAD_MS / 1000}s)`,
            context: WorkerHealthGuardService.name,
            metadata: { instanceId: this.instanceId },
        });
    }

    // ───────────────────── Helpers ─────────────────────

    /**
     * Derive expected channels from the AmqpConnection config instead
     * of hardcoding. Falls back to known defaults.
     */
    private getExpectedChannelNames(): string[] {
        try {
            const config = (this.amqpConnection as any)?.config;
            if (config?.channels && typeof config.channels === 'object') {
                return Object.keys(config.channels);
            }
        } catch {
            // Fallback below.
        }

        return [
            'channel-webhook',
            'channel-code-review',
            'channel-check-implementation',
            'channel-feedback',
        ];
    }

    private getChannelStatus(): {
        alive: string[];
        dead: string[];
        consumers: Record<string, number>;
    } {
        const managedChannels = this.amqpConnection!.managedChannels;
        const expectedChannels = this.getExpectedChannelNames();
        const alive: string[] = [];
        const dead: string[] = [];
        const consumers: Record<string, number> = {};

        // @golevelup v9: consumers live on AmqpConnection._consumers (Record
        // keyed by consumerTag), not on each ChannelWrapper. The named channel
        // lives at msgOptions.queueOptions.channel (same path the lib itself
        // uses to dispatch — see selectManagedChannel call site).
        const consumersMap =
            (this.amqpConnection as unknown as { _consumers?: Record<string, unknown> })._consumers ?? {};
        const consumerCountByChannel: Record<string, number> = {};
        type ConsumerOpts = { queueOptions?: { channel?: string }; channel?: string };
        for (const c of Object.values(consumersMap)) {
            const opts = (c as { msgOptions?: ConsumerOpts })?.msgOptions;
            const channelName: string =
                opts?.queueOptions?.channel ?? opts?.channel ?? '__default__';
            consumerCountByChannel[channelName] =
                (consumerCountByChannel[channelName] ?? 0) + 1;
        }

        for (const name of expectedChannels) {
            const wrapper = managedChannels[name] as any;
            if (!wrapper || !wrapper._channel) {
                dead.push(name);
                consumers[name] = 0;
            } else {
                alive.push(name);
                consumers[name] = consumerCountByChannel[name] ?? 0;
            }
        }

        return { alive, dead, consumers };
    }

    /**
     * Graceful exit: uses app.close() which triggers OnApplicationShutdown
     * hooks (including releaseAllByInstance for inbox locks). Falls back
     * to process.exit if close fails.
     */
    private exitGracefully(code: number): void {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        this.logger.log({
            message: 'Initiating graceful shutdown...',
            context: WorkerHealthGuardService.name,
            metadata: { instanceId: this.instanceId, exitCode: code },
        });

        // Give shutdown hooks 30s to run, then force exit.
        // This must be longer than the WorkerDrainService timeout (default 25s).
        const forceExitTimer = setTimeout(() => {
            this.logger.error({
                message: 'Graceful shutdown timed out. Force exiting.',
                context: WorkerHealthGuardService.name,
                metadata: { instanceId: this.instanceId },
            });
            process.exit(code);
        }, 30_000);

        // process.kill(process.pid, 'SIGTERM') triggers NestJS shutdown hooks
        // (enableShutdownHooks is called in main.ts), which runs:
        // - WorkerDrainService.onApplicationShutdown (close consumers)
        // - WorkflowJobConsumer.onApplicationShutdown (release inbox locks)
        // - This service's onApplicationShutdown (cleanup timer)
        process.kill(process.pid, 'SIGTERM');

        // Unref so the timer doesn't keep the process alive if shutdown completes.
        forceExitTimer.unref();
    }

    // ───────────────────── Cleanup ─────────────────────

    async onApplicationShutdown(): Promise<void> {
        this.isShuttingDown = true;

        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = undefined;
        }
    }
}
