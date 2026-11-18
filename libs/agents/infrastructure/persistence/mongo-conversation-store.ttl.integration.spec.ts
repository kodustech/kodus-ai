/**
 * A Kody conversation expires 30 days after its last reply. That needs a TTL
 * index on a Date field that every append moves forward: before, the TTL
 * pointed at a field these documents never had and nothing ever expired.
 *
 * Runs against a REAL MongoDB in a throwaway database.
 */
import mongoose, { Connection, Model } from 'mongoose';

import { MongoConversationStore } from './mongo-conversation-store';
import {
    AGENT_SESSION_TTL_SECONDS,
    AgentSessionModel,
    AgentSessionSchema,
} from './schemas/agent-session.model';
import { resolveMongoTestGate } from '../../../../test/integration/mongo-test-uri';

// Runs in CI (TEST_MONGODB_URI); skips locally without it, fails in CI
// when the URI is missing instead of passing with nothing asserted.
const gate = resolveMongoTestGate();
const TEST_DB = 'kodus_agent_sessions_ttl_it';

let connection: Connection | null = null;
let available = false;

(gate.shouldSkip ? describe.skip : describe)(
    'kodus-agent-sessions expiry (real MongoDB)',
    () => {
        let model: Model<AgentSessionModel>;
        let store: MongoConversationStore;

        beforeAll(async () => {
            const uri = gate.mongoUri;
            connection = await mongoose
                .createConnection(uri, {
                    dbName: TEST_DB,
                    serverSelectionTimeoutMS: 2000,
                })
                .asPromise();
            available = true;
            await connection.dropDatabase();
            model = connection.model<AgentSessionModel>(
                AgentSessionModel.name,
                AgentSessionSchema,
            );
            // What autoIndex does on boot.
            await model.init();
            store = new MongoConversationStore(model as any);
        }, 30_000);

        afterAll(async () => {
            if (connection) {
                if (available) await connection.dropDatabase();
                await connection.close();
            }
        });

        it('expires a conversation 30 days after its last reply', async () => {
            const ttl = (await model.collection.indexes()).find(
                (index) => index.expireAfterSeconds !== undefined,
            );

            expect(ttl?.key).toEqual({ updatedAt: 1 });
            expect(ttl?.expireAfterSeconds).toBe(AGENT_SESSION_TTL_SECONDS);
            expect(AGENT_SESSION_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
        });

        it('restarts the clock on every reply', async () => {
            await store.append('thread-1', [{ role: 'user', content: 'hi' }]);
            const first = await model.findOne({ threadId: 'thread-1' }).lean();
            await new Promise((resolve) => setTimeout(resolve, 20));
            await store.append('thread-1', [
                { role: 'assistant', content: 'hello' },
            ]);
            const second = await model.findOne({ threadId: 'thread-1' }).lean();

            // A Date the TTL monitor can read, moved forward by the reply.
            expect((first as any).updatedAt).toBeInstanceOf(Date);
            expect((second as any).updatedAt.getTime()).toBeGreaterThan(
                (first as any).updatedAt.getTime(),
            );
            expect(await store.load('thread-1')).toEqual([
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'hello' },
            ]);
        });
    },
);
