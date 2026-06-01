/**
 * Intentionally kept broad to avoid leaking infrastructure-only enums into the domain contracts.
 * Concrete implementations typically use a string enum persisted in the DB.
 */
export type InboxStatus = unknown;

export interface InboxHealthStats {
    ready: number;
    processing: number;
    processed: number;
    failed: number;
    oldestProcessing?: Date;
}

export interface IInboxMessageRepository {
    claim(
        messageId: string,
        consumerId: string,
        lockedBy: string,
        jobId?: string,
        /**
         * Minutes after which a message stuck in PROCESSING can be
         * reclaimed by another worker. Defaults to 150 (2.5h) — appropriate
         * for long-running workflows like code review (2h + margin).
         * Pass a smaller value for short jobs (e.g. AST build at ~30min)
         * so a hard worker crash doesn't block retries for hours.
         */
        claimTimeoutMinutes?: number,
    ): Promise<unknown | null>;
    findByConsumerAndMessageId(
        consumerId: string,
        messageId: string,
    ): Promise<{ status: InboxStatus } | null>;
    markAsProcessed(messageId: string, consumerId: string): Promise<void>;
    releaseLock(
        messageId: string,
        consumerId: string,
        lastError?: string,
    ): Promise<void>;
    reclaimStaleMessages(olderThan: Date): Promise<number>;
    reclaimStaleMessagesByConsumer(
        consumerId: string,
        olderThan: Date,
    ): Promise<number>;
    /**
     * Releases every PROCESSING lock held by the given instance (hostname).
     * Used during graceful shutdown so new workers can reclaim the messages
     * immediately instead of waiting for the reaper timeout.
     */
    releaseAllByInstance(lockedBy: string): Promise<number>;
    deleteProcessedOlderThan(date: Date): Promise<number>;
    getHealthStats(): Promise<InboxHealthStats>;
}

export const INBOX_MESSAGE_REPOSITORY_TOKEN = Symbol.for(
    'InboxMessageRepository',
);
