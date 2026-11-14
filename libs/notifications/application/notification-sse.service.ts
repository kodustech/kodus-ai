import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { createLogger } from '@libs/core/log/logger';
import type { Response } from 'express';

/**
 * Manages SSE connections for real-time notification delivery to the
 * frontend. Each connected user has a set of Response objects that we
 * write events to.
 */
@Injectable()
export class NotificationSseService implements BeforeApplicationShutdown {
    private readonly logger = createLogger(NotificationSseService.name);
    private readonly connections = new Map<string, Set<Response>>();
    /** Streams opened and not registered yet: still reading their first event. */
    private readonly opening = new Set<Response>();
    private closing = false;

    /**
     * Ends every open stream, the ones still opening too. Nest closes the
     * HTTP server right after this hook, and a server waits for its open
     * responses: a stream left open would keep the process alive until the
     * browser went away. The client reconnects by itself, to whichever
     * instance is up.
     */
    beforeApplicationShutdown(): void {
        this.closing = true;
        for (const res of [
            ...this.opening,
            ...[...this.connections.values()].flatMap((set) => [...set]),
        ]) {
            this.end(res);
        }
        this.opening.clear();
        this.connections.clear();
    }

    /**
     * Tracks a stream from the moment its headers are sent, so a shutdown
     * that starts before it is registered still ends it. False once the
     * shutdown started: the stream is ended at once.
     */
    openConnection(res: Response): boolean {
        if (this.closing) {
            this.end(res);
            return false;
        }
        this.opening.add(res);
        return true;
    }

    /** False once the shutdown started: the stream is ended, not registered. */
    addConnection(userId: string, res: Response): boolean {
        this.opening.delete(res);
        if (this.closing) {
            this.end(res);
            return false;
        }
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
        return true;
    }

    removeConnection(userId: string, res: Response): void {
        this.opening.delete(res);
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

    private end(res: Response): void {
        try {
            res.end();
        } catch {
            // Already gone.
        }
    }
}
