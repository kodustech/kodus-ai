import type {
    ClaimRequest,
    RuntimePublication,
} from '../domain/runtime-publication';
import { MongoPublicationReader, MongoPublicationStore } from './mongo-publication.store';

const NOW = new Date('2026-10-29T12:00:00.000Z');

function request(overrides: Partial<ClaimRequest> = {}): ClaimRequest {
    return {
        key: 'run-1:1:comment',
        runId: 'run-1',
        attempt: 1,
        kind: 'comment',
        organizationId: 'org-a',
        teamId: 'team-a',
        repositoryId: 'repo-1',
        prNumber: 42,
        headSha: 'a'.repeat(40),
        ...overrides,
    };
}

function fakeCollection() {
    return {
        findOneAndUpdate: jest.fn().mockResolvedValue(null),
        insertOne: jest.fn().mockResolvedValue({ acknowledged: true }),
        findOne: jest.fn().mockResolvedValue(null),
        updateOne: jest.fn().mockResolvedValue({}),
        createIndex: jest.fn().mockResolvedValue('ok'),
        find: jest.fn(),
    };
}

/** A find() cursor that answers `rows` and records its sort and limit. */
function cursor(rows: unknown[]) {
    const c = { sort: jest.fn(), limit: jest.fn(), toArray: jest.fn().mockResolvedValue(rows) };
    c.sort.mockReturnValue(c);
    c.limit.mockReturnValue(c);
    return c;
}

describe('MongoPublicationStore', () => {
    it('inserts a fresh claim when no row can be taken', async () => {
        const c = fakeCollection();
        const out = await new MongoPublicationStore(c as any).claim(
            request(),
            NOW,
        );

        expect(out.state).toBe('claimed');
        expect(c.insertOne).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'run-1:1:comment',
                status: 'publishing',
                leaseUntil: '2026-10-29T12:05:00.000Z',
            }),
        );
    });

    it('never takes a published comment over, and takes failed or expired rows', async () => {
        const c = fakeCollection();
        await new MongoPublicationStore(c as any).claim(request(), NOW);

        const filter = c.findOneAndUpdate.mock.calls[0][0];
        expect(filter.key).toBe('run-1:1:comment');
        expect(filter.$or).toEqual([
            { status: 'failed' },
            { status: 'publishing', leaseUntil: { $lte: NOW.toISOString() } },
        ]);
        expect(filter.$and).toBeUndefined();
    });

    it('takes a published check over only for a later status', async () => {
        const c = fakeCollection();
        await new MongoPublicationStore(c as any).claim(
            request({ key: 'run-1:1:check', kind: 'check', checkRank: 3 }),
            NOW,
        );

        const filter = c.findOneAndUpdate.mock.calls[0][0];
        expect(filter.$or).toContainEqual({ status: 'published' });
        expect(filter.$and[0].$or).toContainEqual({ checkRank: { $lt: 3 } });
        // The rank is stored on completion, not on claim.
        expect(c.insertOne.mock.calls[0][0]).not.toHaveProperty('checkRank');
    });

    it('reports busy when the unique key is held by a live claim', async () => {
        const c = fakeCollection();
        c.insertOne.mockRejectedValue(
            Object.assign(new Error('E11000'), { code: 11000 }),
        );
        c.findOne.mockResolvedValue({
            key: 'run-1:1:comment',
            status: 'publishing',
            leaseUntil: '2026-10-29T12:04:00.000Z',
        });

        const out = await new MongoPublicationStore(c as any).claim(
            request(),
            NOW,
        );

        expect(out.state).toBe('busy');
    });

    it('reports duplicate when the key is already published', async () => {
        const c = fakeCollection();
        c.insertOne.mockRejectedValue(
            Object.assign(new Error('E11000'), { code: 11000 }),
        );
        c.findOne.mockResolvedValue({
            key: 'run-1:1:comment',
            status: 'published',
        } as Partial<RuntimePublication>);

        const out = await new MongoPublicationStore(c as any).claim(
            request(),
            NOW,
        );

        expect(out.state).toBe('duplicate');
    });

    it('rethrows any other insert error', async () => {
        const c = fakeCollection();
        c.insertOne.mockRejectedValue(new Error('connection reset'));

        await expect(
            new MongoPublicationStore(c as any).claim(request(), NOW),
        ).rejects.toThrow('connection reset');
    });

    it('reads the check run recorded under a phase key, by that exact key', async () => {
        const c = fakeCollection();
        c.findOne.mockResolvedValue({ checkRunId: 555 });
        const store = new MongoPublicationStore(c as any);

        await expect(
            store.findCheckRunId('run-1:1:check:awaiting_approval'),
        ).resolves.toBe(555);
        expect(c.findOne).toHaveBeenCalledWith(
            {
                key: 'run-1:1:check:awaiting_approval',
                kind: 'check',
                checkRunId: { $exists: true },
            },
            expect.anything(),
        );

        c.findOne.mockResolvedValue(null);
        await expect(store.findCheckRunId('run-1:1:check:x')).resolves.toBeNull();
    });

    it('creates the unique key index, and the indexes of the Run page and the sweeper', async () => {
        const c = fakeCollection();
        await MongoPublicationStore.ensureIndexes(c as any);
        expect(c.createIndex).toHaveBeenCalledWith(
            { key: 1 },
            expect.objectContaining({ unique: true }),
        );
        expect(c.createIndex).toHaveBeenCalledWith({ organizationId: 1, runId: 1 }, expect.anything());
        expect(c.createIndex).toHaveBeenCalledWith({ status: 1, updatedAt: 1 }, expect.anything());
    });

    it('keeps the request with a claim that carries one, on insert and on takeover', async () => {
        const c = fakeCollection();
        const stored = { runId: 'run-1' } as any;
        await new MongoPublicationStore(c as any).claim(request({ request: stored }), NOW);

        expect(c.findOneAndUpdate.mock.calls[0][1].$set.request).toBe(stored);
        expect(c.insertOne).toHaveBeenCalledWith(expect.objectContaining({ request: stored }));
    });

    it('finds stale final publications: failed or expired, with a request, not given up, oldest first, bounded', async () => {
        const c = fakeCollection();
        const cur = cursor([]);
        c.find.mockReturnValue(cur);
        await new MongoPublicationStore(c as any).findStale('2026-10-29T11:58:00.000Z', NOW.toISOString(), 20);

        expect(c.find).toHaveBeenCalledWith(
            {
                $or: [{ status: 'failed' }, { status: 'publishing', leaseUntil: { $lte: NOW.toISOString() } }],
                updatedAt: { $lte: '2026-10-29T11:58:00.000Z' },
                request: { $exists: true },
                'redrive.gaveUpAt': { $exists: false },
            },
            { projection: { _id: 0 } },
        );
        expect(cur.sort).toHaveBeenCalledWith({ updatedAt: 1 });
        expect(cur.limit).toHaveBeenCalledWith(20);
    });

    it('reserves a redrive only on the row the sweeper read', async () => {
        const c = fakeCollection();
        await new MongoPublicationStore(c as any).reserveRedrive('run-1:1:comment', 'seen', NOW.toISOString());
        const [filter, update] = c.findOneAndUpdate.mock.calls[0];
        expect(filter).toMatchObject({ key: 'run-1:1:comment', updatedAt: 'seen', 'redrive.gaveUpAt': { $exists: false } });
        expect(update).toEqual({ $inc: { 'redrive.attempts': 1 }, $set: { 'redrive.lastAt': NOW.toISOString(), updatedAt: NOW.toISOString() } });
    });

    it('a given-up row stays failed, with the reason code', async () => {
        const c = fakeCollection();
        await new MongoPublicationStore(c as any).giveUp('run-1:1:comment', 'attempts', NOW.toISOString());
        expect(c.updateOne).toHaveBeenCalledWith(
            { key: 'run-1:1:comment' },
            expect.objectContaining({ $set: expect.objectContaining({ status: 'failed', 'redrive.gaveUpReason': 'attempts' }) }),
        );
    });
});

describe('MongoPublicationReader', () => {
    it('reads one Run of one org, without the stored request, bounded', async () => {
        const c = fakeCollection();
        const cur = cursor([{ key: 'run-1:1:check' }]);
        c.find.mockReturnValue(cur);

        await expect(new MongoPublicationReader(c as any).listForRun('org-a', 'run-1')).resolves.toEqual([{ key: 'run-1:1:check' }]);
        expect(c.find).toHaveBeenCalledWith({ organizationId: 'org-a', runId: 'run-1' }, { projection: { _id: 0, request: 0 } });
        expect(cur.limit).toHaveBeenCalledWith(50);
    });
});
