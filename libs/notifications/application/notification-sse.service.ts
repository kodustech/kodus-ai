import { Injectable } from '@nestjs/common';
import { createLogger } from '@kodus/flow';
import type { Response } from 'express';

/**
 * Manages SSE connections for real-time notification delivery to the
 * frontend. Each connected user has a set of Response objects that we
 * write events to.
 */
@Injectable()
export class NotificationSseService {
    private readonly logger = createLogger(NotificationSseService.name);
    private readonly connections = new Map<string, Set<Response>>();

    addConnection(userId: string, res: Response): void {
        let set = this.connections.get(userId);
        if (!set) {
            set = new Set();
            this.connections.set(userId, set);
        }
        set.add(res);

        this.logger.log({
            message: 'SSE connection added',
            context: NotificationSseService.name,
            metadata: {
                userId,
                activeConnections: set.size,
            },
        });
    }

    removeConnection(userId: string, res: Response): void {
        const set = this.connections.get(userId);
        if (set) {
            set.delete(res);
            if (set.size === 0) {
                this.connections.delete(userId);
            }
        }
    }

    pushEvent(
        userId: string,
        event: { type: string; data: unknown },
    ): void {
        const set = this.connections.get(userId);
        if (!set || set.size === 0) return;

        const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;

        for (const res of set) {
            try {
                res.write(payload);
            } catch {
                // Connection broken — will be cleaned up on close
                set.delete(res);
            }
        }
    }

    /** Broadcast to all connected users. */
    broadcast(event: { type: string; data: unknown }): void {
        for (const [userId] of this.connections) {
            this.pushEvent(userId, event);
        }
    }
}
