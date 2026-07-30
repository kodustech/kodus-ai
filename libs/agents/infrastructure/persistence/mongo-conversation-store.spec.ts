import { MongoConversationStore } from './mongo-conversation-store';

/**
 * Unit tests for the conversation record adapter. The Mongoose model is mocked
 * — we assert the query shape (load mapping, upsert operators), not Mongo itself.
 */
describe('MongoConversationStore', () => {
    let updateOne: jest.Mock;
    let findOne: jest.Mock;
    let exec: jest.Mock;
    let model: any;
    let store: MongoConversationStore;

    beforeEach(() => {
        updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
        exec = jest.fn();
        findOne = jest.fn().mockReturnValue({
            lean: () => ({ exec }),
        });
        model = { updateOne, findOne };
        store = new MongoConversationStore(model);
    });

    describe('load', () => {
        it('maps persisted messages to {role, content}, oldest first', async () => {
            exec.mockResolvedValue({
                sessionData: {
                    runtime: {
                        messages: [
                            { role: 'user', content: 'hi', ts: 1 },
                            { role: 'assistant', content: 'hello', ts: 2 },
                        ],
                    },
                },
            });

            const out = await store.load('thread-1');

            expect(findOne).toHaveBeenCalledWith({ threadId: 'thread-1' });
            expect(out).toEqual([
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'hello' },
            ]);
        });

        it('returns [] when no document exists', async () => {
            exec.mockResolvedValue(null);
            expect(await store.load('missing')).toEqual([]);
        });

        it('returns [] (and does not throw) on a read error', async () => {
            exec.mockRejectedValue(new Error('mongo down'));
            expect(await store.load('thread-1')).toEqual([]);
        });

        it('returns [] for an empty threadId without querying', async () => {
            expect(await store.load('')).toEqual([]);
            expect(findOne).not.toHaveBeenCalled();
        });
    });

    describe('append', () => {
        it('upserts by threadId, pushing capped messages and tenancy meta', async () => {
            await store.append(
                'thread-1',
                [
                    { role: 'user', content: 'q' },
                    { role: 'assistant', content: 'a' },
                ],
                {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                    repositoryId: 'repo-1',
                    channel: 'pr',
                    correlationId: 'corr-1',
                },
            );

            expect(updateOne).toHaveBeenCalledTimes(1);
            const [filter, update, options] = updateOne.mock.calls[0];

            expect(filter).toEqual({ threadId: 'thread-1' });
            expect(options).toEqual({ upsert: true });

            // Insert-only identity / created stamps.
            expect(update.$setOnInsert['sessionData.threadId']).toBe('thread-1');
            expect(update.$setOnInsert['sessionData.tenantId']).toBe(
                'kodus-agent-conversation',
            );
            expect(update.$setOnInsert.id).toBe(
                update.$setOnInsert['sessionData.sessionId'],
            );

            // Activity + tenancy on every write.
            expect(update.$set['sessionData.status']).toBe('active');
            expect(update.$set['sessionData.organizationId']).toBe('org-1');
            expect(update.$set['sessionData.channel']).toBe('pr');
            expect(update.$set['sessionData.lastCorrelationId']).toBe('corr-1');

            // Messages pushed with a bounded tail.
            const pushed = update.$push['sessionData.runtime.messages'];
            expect(pushed.$each).toHaveLength(2);
            expect(pushed.$each[0]).toMatchObject({ role: 'user', content: 'q' });
            expect(pushed.$slice).toBe(-100);
            expect(update.$push['sessionData.correlationIdHistory']).toBe(
                'corr-1',
            );
        });

        it('omits tenancy keys the caller did not provide', async () => {
            await store.append('thread-1', [{ role: 'user', content: 'q' }]);

            const update = updateOne.mock.calls[0][1];
            expect(update.$set['sessionData.tenantId']).toBeUndefined();
            expect(update.$set).not.toHaveProperty('sessionData.organizationId');
            expect(update.$set).not.toHaveProperty('sessionData.channel');
            expect(update.$push).not.toHaveProperty(
                'sessionData.correlationIdHistory',
            );
        });

        it('is a no-op for empty threadId or empty turns', async () => {
            await store.append('', [{ role: 'user', content: 'q' }]);
            await store.append('thread-1', []);
            expect(updateOne).not.toHaveBeenCalled();
        });

        it('swallows a write error (never throws)', async () => {
            updateOne.mockRejectedValue(new Error('mongo down'));
            await expect(
                store.append('thread-1', [{ role: 'user', content: 'q' }]),
            ).resolves.toBeUndefined();
        });
    });
});
