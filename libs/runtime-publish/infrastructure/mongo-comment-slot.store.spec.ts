import { MongoCommentSlotStore } from './mongo-comment-slot.store';

const PR = { organizationId: 'org-a', teamId: 'team-a', repositoryId: 'repo-1', prNumber: 42 };
const NOW = new Date('2026-10-31T12:00:00.000Z');

function fakeCollection() {
    return {
        findOneAndUpdate: jest.fn().mockResolvedValue({ ...PR, leaseOwner: 'me', updatedAt: NOW.toISOString() }),
        updateOne: jest.fn().mockResolvedValue({}),
        createIndex: jest.fn().mockResolvedValue('ok'),
    };
}

describe('MongoCommentSlotStore', () => {
    it('takes the slot only when no live lease holds it, upserting the first one', async () => {
        const c = fakeCollection();
        const slot = await new MongoCommentSlotStore(c as any).acquire(PR, 'me', NOW);

        expect(slot).toMatchObject({ leaseOwner: 'me' });
        const [filter, update, options] = c.findOneAndUpdate.mock.calls[0];
        expect(filter).toMatchObject({ organizationId: 'org-a', repositoryId: 'repo-1', prNumber: 42 });
        expect(filter.$or).toContainEqual({ leaseUntil: { $lte: NOW.toISOString() } });
        expect(update.$set).toMatchObject({ leaseOwner: 'me', leaseUntil: '2026-10-31T12:02:00.000Z' });
        expect(options).toMatchObject({ upsert: true });
    });

    it('answers null (busy) when the upsert meets the unique PR key of a live lease', async () => {
        const c = fakeCollection();
        c.findOneAndUpdate.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));
        expect(await new MongoCommentSlotStore(c as any).acquire(PR, 'me', NOW)).toBeNull();
    });

    it('rethrows any other error', async () => {
        const c = fakeCollection();
        c.findOneAndUpdate.mockRejectedValueOnce(new Error('down'));
        await expect(new MongoCommentSlotStore(c as any).acquire(PR, 'me', NOW)).rejects.toThrow('down');
    });

    it('writes and releases only under its own lease', async () => {
        const c = fakeCollection();
        const store = new MongoCommentSlotStore(c as any);
        await store.update(PR, 'me', { comment: { id: 7 }, commentOrder: 5, createPending: false });
        await store.release(PR, 'me');

        const [filter, update] = c.updateOne.mock.calls[0];
        expect(filter).toMatchObject({ leaseOwner: 'me', prNumber: 42 });
        expect(update.$set).toMatchObject({ comment: { id: 7 }, commentOrder: 5 });
        expect(update.$unset).toEqual({ createPending: '' });
        expect(c.updateOne.mock.calls[1]).toEqual([expect.objectContaining({ leaseOwner: 'me' }), { $unset: { leaseOwner: '', leaseUntil: '' } }]);
    });

    it('creates the unique PR index', async () => {
        const c = fakeCollection();
        await MongoCommentSlotStore.ensureIndexes(c as any);
        expect(c.createIndex).toHaveBeenCalledWith({ organizationId: 1, repositoryId: 1, prNumber: 1 }, { unique: true, name: 'pr_comment_slot' });
    });
});
