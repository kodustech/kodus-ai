import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';

/**
 * Mongo model for `kodus-agent-sessions` — the conversation record that used to
 * be written by the `@kodus/flow` session engine.
 *
 * Faithful to the legacy document's recognizable OUTER shape
 * (`id` / `threadId` / `timestamp` / `sessionData.runtime.messages`) so support
 * and BI queries against this collection keep working. The orchestrator-only
 * fields are intentionally dropped (`execution`/`stepsJournal`, `state.phase`,
 * `version` optimistic-lock, `entities`) — the AI SDK loop is stateless and
 * does not need them. One document per `threadId` (upsert).
 */

interface PersistedMessage {
    role: 'user' | 'assistant';
    content: string;
    ts: number;
}

interface PersistedSessionData {
    sessionId: string;
    threadId: string;
    tenantId: string;
    status: 'active' | 'completed';
    runtime: { messages: PersistedMessage[] };
    organizationId?: string;
    teamId?: string;
    repositoryId?: string;
    channel?: string;
    createdAt: Date;
    lastActivityAt: Date;
    createdAtTimestamp: number;
    lastActivityTimestamp: number;
    lastCorrelationId?: string;
    correlationIdHistory: string[];
}

@Schema({
    collection: 'kodus-agent-sessions',
    timestamps: true,
    // autoIndex on boot is the repo convention (no Mongo index migration
    // mechanism exists for mongoose models here). Safe because the indexes
    // below are NON-UNIQUE and background: building them over the existing
    // legacy `@kodus/flow` documents cannot fail on duplicate threadIds and
    // does not block startup. (A unique build WOULD have failed — see below.)
    autoIndex: true,
})
export class AgentSessionModel extends CoreDocument {
    /** Session id (legacy callers keyed reads on this). */
    @Prop({ type: String, required: true })
    id: string;

    /** Continuity key — one session document per thread. */
    @Prop({ type: String, required: true })
    threadId: string;

    /** Last-activity epoch ms (mirrors `sessionData.lastActivityTimestamp`). */
    @Prop({ type: Number, required: true })
    timestamp: number;

    @Prop({
        type: {
            sessionId: { type: String, required: true },
            threadId: { type: String, required: true },
            tenantId: { type: String, required: true },
            status: {
                type: String,
                required: true,
                enum: ['active', 'completed'],
            },
            runtime: {
                type: {
                    messages: {
                        type: [
                            {
                                role: {
                                    type: String,
                                    required: true,
                                    enum: ['user', 'assistant'],
                                },
                                content: { type: String, required: true },
                                ts: { type: Number, required: true },
                            },
                        ],
                        default: [],
                    },
                },
                _id: false,
                required: true,
            },
            organizationId: { type: String, required: false },
            teamId: { type: String, required: false },
            repositoryId: { type: String, required: false },
            channel: { type: String, required: false },
            createdAt: { type: Date, required: true },
            lastActivityAt: { type: Date, required: true },
            createdAtTimestamp: { type: Number, required: true },
            lastActivityTimestamp: { type: Number, required: true },
            lastCorrelationId: { type: String, required: false },
            correlationIdHistory: { type: [String], default: [] },
        },
        _id: false,
        required: true,
    })
    sessionData: PersistedSessionData;
}

export const AgentSessionSchema = SchemaFactory.createForClass(AgentSessionModel);

// Upsert/lookup key. Deliberately NOT unique: the legacy flow engine could
// write multiple documents per threadId (a new session per TTL window), so a
// unique build would fail on the existing collection. Uniqueness is best-effort
// via the upsert filter; under a concurrent first-insert two docs may appear,
// which is acceptable for a best-effort record.
AgentSessionSchema.index(
    { threadId: 1 },
    { name: 'idx_thread', background: true },
);

// Common BI/support filters by tenant.
AgentSessionSchema.index(
    { 'sessionData.organizationId': 1, 'sessionData.teamId': 1 },
    { name: 'idx_org_team', background: true },
);

export const AgentSessionModelInstance = {
    name: AgentSessionModel.name,
    schema: AgentSessionSchema,
};
