// Branded ID aliases (plain strings, inlined from the former flow types).
type CallId = string;
type CorrelationId = string;
type EventId = string;
type ExecutionId = string;
type SessionId = string;
type TenantId = string;

import { randomBytes } from 'crypto';

/**
 * High-performance ID generator using crypto.randomBytes
 * Provides collision-resistant IDs with timing information
 */
export class IdGenerator {
    private static readonly base62Chars =
        '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    private static counter = 0;

    /**
     * Generate unique execution ID
     * Format: exec_[timestamp]_[random]_[counter]
     */
    static executionId(): ExecutionId {
        const timestamp = Date.now().toString(36);
        const random = this.generateRandomString(8);
        const counter = (++this.counter % 1000).toString(36);
        return `exec_${timestamp}_${random}_${counter}`;
    }

    /**
     * Generate unique correlation ID
     * Format: corr_[random]_[timestamp]
     */
    static correlationId(): CorrelationId {
        const random = this.generateRandomString(12);
        const timestamp = Date.now().toString(36);
        return `corr_${random}_${timestamp}`;
    }

    /**
     * Generate unique call ID for tool calls
     * Format: call_[random]_[performance_now]
     */
    static callId(): CallId {
        const random = this.generateRandomString(6);
        const perfNow = Math.floor(performance.now() * 1000).toString(36);
        return `call_${random}_${perfNow}`;
    }

    /**
     * Generate session ID
     * Format: sess_[random]_[timestamp]
     */
    static sessionId(): SessionId {
        const random = this.generateRandomString(10);
        const timestamp = Date.now().toString(36);
        return `sess_${random}_${timestamp}`;
    }

    /**
     * Generate tenant ID
     * Format: tenant_[random]
     */
    static tenantId(): TenantId {
        const random = this.generateRandomString(8);
        return `tenant_${random}`;
    }

    static generateTraceId(): string {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substring(2, 8);
        return `trace_${timestamp}_${random}`;
    }

    /**
     * Generate a span ID (unique per span)
     */
    static generateSpanId(): string {
        const timestamp = Date.now().toString(36);
        const count = Math.random().toString(36).padStart(4, '0');
        return `span_${timestamp}_${count}`;
    }

    /**
     * Generate random string using crypto.randomBytes
     * Converted to base62 for URL-safe IDs
     * Uses rejection sampling to avoid modulo bias
     */
    private static generateRandomString(length: number): string {
        // 256 / 62 = 4 with remainder, so we reject values >= 248 (62 * 4)
        // This ensures uniform distribution across base62 characters
        const maxValidByte = 248;
        let result = '';

        while (result.length < length) {
            const bytes = randomBytes(
                Math.ceil((length - result.length) * 1.5),
            );
            for (const byte of bytes) {
                if (byte < maxValidByte) {
                    result += this.base62Chars[byte % 62];
                    if (result.length >= length) break;
                }
            }
        }

        return result.slice(0, length);
    }

    /**
     * Validate ID format
     */
    static validateId(
        id: string,
        type: 'execution' | 'correlation' | 'call' | 'session' | 'tenant',
    ): boolean {
        const patterns = {
            execution: /^exec_[a-z0-9]{8,}_[A-Za-z0-9]{8}_[a-z0-9]{1,3}$/,
            correlation: /^corr_[A-Za-z0-9]{12}_[a-z0-9]{8,}$/,
            call: /^call_[A-Za-z0-9]{6}_[a-z0-9]{6,}$/,
            session: /^sess_[A-Za-z0-9]{10}_[a-z0-9]{8,}$/,
            tenant: /^tenant_[A-Za-z0-9]{8}$/,
        };

        return patterns[type].test(id);
    }

    /**
     * Extract timestamp from ID (if available)
     */
    static extractTimestamp(id: string): number | null {
        const parts = id.split('_');
        if (parts.length >= 3) {
            try {
                // Try to parse timestamp from second part
                const timestampPart = parts[1];
                if (timestampPart) {
                    const timestamp = parseInt(timestampPart, 36);
                    if (timestamp > 0) {
                        return timestamp;
                    }
                }
            } catch {
                // Ignore parsing errors
            }
        }
        return null;
    }

    /**
     * Generate unique event ID
     * Format: evt_[random]_[timestamp]
     */
    static eventId(): EventId {
        const random = this.generateRandomString(8);
        const timestamp = Date.now().toString(36);
        return `evt_${random}_${timestamp}`;
    }

    /**
     * Generate unique trace ID
     * Format: trace_[random]_[timestamp]
     */
    static traceId(): string {
        const random = this.generateRandomString(12);
        const timestamp = Date.now().toString(36);
        return `trace_${random}_${timestamp}`;
    }

    /**
     * Generate unique span ID
     * Format: span_[random]
     */
    static spanId(): string {
        const random = this.generateRandomString(8);
        return `span_${random}`;
    }

    /**
     * Generate unique message ID for chat messages
     * Format: msg_[timestamp]_[random]
     */
    static messageId(): string {
        const timestamp = Date.now().toString(36);
        const random = this.generateRandomString(9);
        return `msg_${timestamp}_${random}`;
    }
}

/**
 * Thread-safe counter for scenarios requiring sequential IDs
 */
export class SequentialIdGenerator {
    private static counters = new Map<string, number>();
    private static readonly mutex = new Map<string, Promise<void>>();

    /**
     * Generate sequential ID with namespace
     */
    static async generateSequential(
        namespace: string,
        prefix: string = '',
    ): Promise<string> {
        // Acquire lock for this namespace
        await this.acquireLock(namespace);

        try {
            const current = this.counters.get(namespace) || 0;
            const next = current + 1;
            this.counters.set(namespace, next);

            const timestamp = Date.now().toString(36);
            const random = IdGenerator['generateRandomString'](4);

            return `${prefix}${next}_${timestamp}_${random}`;
        } finally {
            this.releaseLock(namespace);
        }
    }

    /**
     * Reset counter for namespace
     */
    static async resetCounter(namespace: string): Promise<void> {
        await this.acquireLock(namespace);
        try {
            this.counters.delete(namespace);
        } finally {
            this.releaseLock(namespace);
        }
    }

    private static async acquireLock(namespace: string): Promise<void> {
        const existingLock = this.mutex.get(namespace);
        if (existingLock) {
            await existingLock;
        }

        let resolve: () => void;
        const promise = new Promise<void>((res) => {
            resolve = res;
        });

        this.mutex.set(namespace, promise);

        // Release immediately since we don't have actual async operations
        // This is a simple implementation - for production, consider using a proper mutex library
        setTimeout(() => {
            resolve();
        }, 0);
    }

    private static releaseLock(namespace: string): void {
        this.mutex.delete(namespace);
    }
}

/**
 * Memory-efficient ID generator for high-throughput scenarios
 */
export class HighThroughputIdGenerator {
    private static buffer: Buffer = Buffer.alloc(16);
    private static bufferIndex = 0;

    /**
     * Generate ID using pre-allocated buffer for better performance
     */
    static generateFast(): string {
        // Refresh buffer when needed
        if (this.bufferIndex >= 12) {
            randomBytes(16).copy(this.buffer);
            this.bufferIndex = 0;
        }

        const timestamp = Date.now();
        const random = this.buffer.readUInt32BE(this.bufferIndex);
        this.bufferIndex += 4;

        return `${timestamp.toString(36)}_${random.toString(36)}`;
    }

    /**
     * Generate batch of IDs for bulk operations
     */
    static generateBatch(count: number): string[] {
        const results: string[] = [];
        const timestamp = Date.now().toString(36);

        for (let i = 0; i < count; i++) {
            const random = this.generateFast();
            results.push(`${timestamp}_${random}_${i.toString(36)}`);
        }

        return results;
    }
}
