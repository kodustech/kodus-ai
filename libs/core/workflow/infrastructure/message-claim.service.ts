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
        // One holder per attempt, not per host, so two deliveries handled by
        // the same instance cannot finish or release each other's claim. The
        // instance prefix keeps releaseAllByInstance on shutdown matching it.
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

    async complete(
        consumerId: string,
        key: string,
        holder: string,
    ): Promise<void> {
        await this.inboxRepository.completeIfHeldBy(key, consumerId, holder);
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
