import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type {
    ConversationAppendMeta,
    ConversationMessage,
    ConversationStore,
} from '@libs/agent-harness/domain/contracts';
import { createLogger } from '@libs/core/log/logger';

import { AgentSessionModel } from './schemas/agent-session.model';

/** DI token for the conversation store seam (so the agent depends on the
 *  harness contract, not this Mongo class). */
export const CONVERSATION_STORE_TOKEN = Symbol('ConversationStore');

/** Legacy flow tenant for agent conversations — kept so existing
 *  `kodus-agent-sessions` queries by tenant still match. */
const DEFAULT_TENANT = 'kodus-agent-conversation';

/** Per-thread message cap. Bounds document growth while keeping a useful tail
 *  of context; the store keeps the most recent `MAX_MESSAGES` turns. */
const MAX_MESSAGES = 100;

/**
 * Mongo-backed {@link ConversationStore}, writing the recognizable legacy
 * `kodus-agent-sessions` document (see {@link AgentSessionModel}). Reuses the
 * app's existing Mongoose connection via `@InjectModel` — no second client.
 *
 * Best-effort: persistence failures are logged and swallowed so a Mongo blip
 * never aborts a conversation turn.
 */
@Injectable()
export class MongoConversationStore implements ConversationStore {
    private readonly logger = createLogger(MongoConversationStore.name);

    constructor(
        @InjectModel(AgentSessionModel.name)
        private readonly model: Model<AgentSessionModel>,
    ) {}

    async load(threadId: string): Promise<readonly ConversationMessage[]> {
        if (!threadId) {
            return [];
        }

        try {
            const doc = await this.model
                .findOne({ threadId })
                .lean()
                .exec();

            const messages = doc?.sessionData?.runtime?.messages ?? [];
            return messages.map((m) => ({ role: m.role, content: m.content }));
        } catch (error) {
            this.logger.warn({
                message: 'ConversationStore.load failed; returning empty history',
                context: MongoConversationStore.name,
                metadata: { threadId },
                error,
            });
            return [];
        }
    }

    async append(
        threadId: string,
        turns: readonly ConversationMessage[],
        meta?: ConversationAppendMeta,
    ): Promise<void> {
        if (!threadId || turns.length === 0) {
            return;
        }

        const now = Date.now();
        const nowDate = new Date(now);
        const newMessages = turns.map((t) => ({
            role: t.role,
            content: t.content,
            ts: now,
        }));

        // Only persist tenancy fields the caller actually knows (avoid writing
        // nulls over a previously-set value).
        const set: Record<string, unknown> = {
            threadId,
            timestamp: now,
            'sessionData.status': 'active',
            'sessionData.lastActivityAt': nowDate,
            'sessionData.lastActivityTimestamp': now,
        };
        if (meta?.organizationId)
            set['sessionData.organizationId'] = meta.organizationId;
        if (meta?.teamId) set['sessionData.teamId'] = meta.teamId;
        if (meta?.repositoryId)
            set['sessionData.repositoryId'] = meta.repositoryId;
        if (meta?.channel) set['sessionData.channel'] = meta.channel;
        if (meta?.correlationId)
            set['sessionData.lastCorrelationId'] = meta.correlationId;

        const push: Record<string, unknown> = {
            'sessionData.runtime.messages': {
                $each: newMessages,
                $slice: -MAX_MESSAGES,
            },
        };
        if (meta?.correlationId)
            push['sessionData.correlationIdHistory'] = meta.correlationId;

        try {
            const sessionId = randomUUID();
            await this.model.updateOne(
                { threadId },
                {
                    $setOnInsert: {
                        id: sessionId,
                        'sessionData.sessionId': sessionId,
                        'sessionData.threadId': threadId,
                        'sessionData.tenantId': meta?.tenantId ?? DEFAULT_TENANT,
                        'sessionData.createdAt': nowDate,
                        'sessionData.createdAtTimestamp': now,
                    },
                    $set: set,
                    $push: push,
                },
                { upsert: true },
            );
        } catch (error) {
            this.logger.warn({
                message: 'ConversationStore.append failed; turn not persisted',
                context: MongoConversationStore.name,
                metadata: { threadId, turns: turns.length },
                error,
            });
        }
    }
}
