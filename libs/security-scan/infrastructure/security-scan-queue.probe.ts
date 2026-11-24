import { Injectable } from '@nestjs/common';
import * as amqplib from 'amqplib';

import { SECURITY_SCAN_JOB_QUEUE } from '@libs/core/workflow/infrastructure/workflow-queue-arguments';

export const SECURITY_SCAN_QUEUE_PROBE_TOKEN = Symbol.for(
    'SecurityScanQueueProbe',
);

export interface ISecurityScanQueueProbe {
    /**
     * Consumers currently bound to the security-scan queue. `null` when the
     * queue does not exist (no worker has declared it) or the broker is off.
     */
    consumerCount(): Promise<number | null>;
}

/**
 * A dedicated short-lived connection: passive checks close their channel on a
 * 404, so they must never run on the app's own channels. One channel per
 * check for the same reason. Same pattern as the self-hosted doctor broker
 * probe.
 */
@Injectable()
export class SecurityScanQueueProbe implements ISecurityScanQueueProbe {
    async consumerCount(): Promise<number | null> {
        if (process.env.API_RABBITMQ_ENABLED === 'false') {
            return null;
        }

        const uri = process.env.API_RABBITMQ_URI || 'amqp://localhost:5672/';
        const connection = await amqplib.connect(uri, { timeout: 5000 });
        connection.on('error', () => undefined);
        try {
            const channel = await connection.createChannel();
            channel.on('error', () => undefined);
            try {
                const { consumerCount } = await channel.checkQueue(
                    SECURITY_SCAN_JOB_QUEUE,
                );
                return consumerCount;
            } catch (error: any) {
                if (error?.code === 404) {
                    return null;
                }
                throw error;
            } finally {
                await channel.close().catch(() => undefined);
            }
        } finally {
            await connection.close().catch(() => undefined);
        }
    }
}
