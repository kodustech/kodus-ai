import { OutboxMessage } from '../interfaces/outbox-message.interface';

export interface IOutboxMessageRepository {
    create(message: OutboxMessage, transactionManager?: unknown): Promise<any>;
    createMany(
        messages: OutboxMessage[],
        transactionManager?: unknown,
    ): Promise<any[]>;
    claimBatch(limit: number, lockedBy: string): Promise<any[]>;
    markAsSent(messageId: string): Promise<void>;
    markAsFailed(
        messageId: string,
        error: string,
        nextAttemptAt: Date,
    ): Promise<void>;
    markAsPermanentlyFailed(messageId: string, error: string): Promise<void>;
    reclaimStaleMessages(olderThan: Date): Promise<number>;
    deleteProcessedOlderThan(date: Date): Promise<number>;
}

export const OUTBOX_MESSAGE_REPOSITORY_TOKEN = Symbol.for(
    'OutboxMessageRepository',
);
