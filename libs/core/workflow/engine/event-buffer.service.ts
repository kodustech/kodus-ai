import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';
import { StageCompletedEvent } from '../domain/interfaces/stage-completed-event.interface';

/**
 * EventBufferService
 * In-memory buffer with TTL to prevent race conditions
 * Stores events that arrive before workflow is paused
 */
@Injectable()
export class EventBufferService {
    private readonly logger = createLogger(EventBufferService.name);
    private readonly buffer = new Map<
        string,
        {
            event: StageCompletedEvent;
            timestamp: number;
            ttl: number;
        }
    >();

    private readonly DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

    /**
     * Store event in buffer
     */
    async store(
        eventType: string,
        eventKey: string,
        event: StageCompletedEvent,
        ttl: number = this.DEFAULT_TTL,
    ): Promise<void> {
        const key = this.getKey(eventType, eventKey);
        this.buffer.set(key, {
            event,
            timestamp: Date.now(),
            ttl,
        });

        this.logger.debug({
            message: `Event stored in buffer`,
            context: EventBufferService.name,
            metadata: {
                eventType,
                eventKey,
                ttl,
            },
        });

        // Schedule cleanup
        setTimeout(() => {
            this.buffer.delete(key);
        }, ttl);
    }

    /**
     * Check if event exists in buffer
     */
    async check(
        eventType: string,
        eventKey: string,
    ): Promise<StageCompletedEvent | null> {
        const key = this.getKey(eventType, eventKey);
        const entry = this.buffer.get(key);

        if (!entry) {
            return null;
        }

        // Check if expired
        if (Date.now() - entry.timestamp > entry.ttl) {
            this.buffer.delete(key);
            return null;
        }

        // Remove from buffer (consumed)
        this.buffer.delete(key);

        this.logger.debug({
            message: `Event found in buffer`,
            context: EventBufferService.name,
            metadata: {
                eventType,
                eventKey,
            },
        });

        return entry.event;
    }

    /**
     * Clear expired entries
     */
    cleanup(): void {
        const now = Date.now();
        for (const [key, entry] of this.buffer.entries()) {
            if (now - entry.timestamp > entry.ttl) {
                this.buffer.delete(key);
            }
        }
    }

    /**
     * Get buffer key from eventType and eventKey
     */
    private getKey(eventType: string, eventKey: string): string {
        return `${eventType}:${eventKey}`;
    }
}
