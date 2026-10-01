import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { Inject, Injectable } from '@nestjs/common';

import {
    IInboxMessageRepository,
    INBOX_MESSAGE_REPOSITORY_TOKEN,
} from '../domain/contracts/inbox-message.repository.contract';
import { IMessageClaimService } from '../domain/contracts/message-claim.service.contract';

/** How long a claim whose holder died blocks a new attempt. */
const DEFAULT_EXPIRES_IN_MINUTES = 15;

@Injectable()
export class MessageClaimService implements IMessageClaimService {
    constructor(
        @Inject(INBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly inboxRepository: IInboxMessageRepository,
    ) {}

    async claim(
        consumerId: string,
        key: string,
        options?: { expiresInMinutes?: number },
    ): Promise<string | null> {
        // One holder per attempt, not per host: two deliveries handled by the
        // same instance must not be able to release each other's claim. (So
        // releaseAllByInstance on shutdown skips these; they just expire.)
        const holder = `${hostname()}:${randomUUID()}`;

        const claimed = await this.inboxRepository.claim(
            key,
            consumerId,
            holder,
            undefined,
            options?.expiresInMinutes ?? DEFAULT_EXPIRES_IN_MINUTES,
        );

        return claimed ? holder : null;
    }

    async complete(consumerId: string, key: string): Promise<void> {
        await this.inboxRepository.markAsProcessed(key, consumerId);
    }

    async release(
        consumerId: string,
        key: string,
        holder: string,
    ): Promise<void> {
        // A claim that expired into another delivery, or that one already
        // completed, must not be reopened: a later delivery would answer twice.
        await this.inboxRepository.releaseIfHeldBy(key, consumerId, holder);
    }
}
