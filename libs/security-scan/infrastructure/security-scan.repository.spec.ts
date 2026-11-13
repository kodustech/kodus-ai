import { SecurityScanRepository } from './security-scan.repository';

describe('SecurityScanRepository', () => {
    it('returns the stored document id as the scan uuid', async () => {
        const doc = {
            _doc: {
                _id: { toString: () => '6650a1b2c3d4e5f6a7b8c9d0' },
                organizationId: 'org-1',
                createdAt: new Date('2026-11-07T00:00:00Z'),
            },
            // What a schema transform does to toObject(): the id is gone.
            toObject: () => ({ organizationId: 'org-1' }),
        };
        const repository = new SecurityScanRepository({
            create: jest.fn(async () => doc),
        } as any);

        const scan = await repository.create({} as any);

        expect(scan.uuid).toBe('6650a1b2c3d4e5f6a7b8c9d0');
        expect(scan.createdAt).toBe('2026-11-07T00:00:00.000Z');
    });
});

describe('SecurityScanRepository.failStale', () => {
    it("fails a running or queued scan silent for longer than its state's window", async () => {
        const updateMany = jest.fn(async () => ({ modifiedCount: 2 }));
        const repository = new SecurityScanRepository({ updateMany } as any);
        const before = Date.now();

        await expect(
            repository.failStale('org-1', { runningMs: 60_000, queuedMs: 600_000 }),
        ).resolves.toBe(2);

        const [filter, update] = updateMany.mock.calls[0] as unknown as [any, any];
        expect(filter.organizationId).toBe('org-1');
        const [running, queued] = filter.$or;
        expect(running.status).toBe('running');
        expect(running.updatedAt.$lt.getTime()).toBeLessThanOrEqual(before - 60_000 + 50);
        // A queued scan waits for a worker as long as the backlog: it has the
        // longer window.
        expect(queued.status).toBe('queued');
        expect(queued.updatedAt.$lt.getTime()).toBeLessThanOrEqual(before - 600_000 + 50);
        expect(queued.updatedAt.$lt.getTime()).toBeGreaterThan(before - 600_000 - 1_000);
        expect(update.$set.status).toBe('failed');
        expect(update.$set.error).toMatch(/Interrupted/);
    });
});

describe('SecurityScanRepository: one active scan per repository', () => {
    const exec = (value: unknown) => ({ exec: jest.fn(async () => value) });

    it('keys a queued scan by its repository, so the unique index refuses a second', async () => {
        const create = jest.fn(async (doc) => ({ _doc: { ...doc, _id: 'id-1' } }));
        const repository = new SecurityScanRepository({ create } as any);

        await repository.create({
            organizationId: 'org-1',
            repository: { platform: 'GITHUB', id: 'repo-1' },
            status: 'queued',
        } as any);
        // A GitLab project with the same id is another repository.
        await repository.create({
            organizationId: 'org-1',
            repository: { platform: 'GITLAB', id: 'repo-1' },
            status: 'queued',
        } as any);

        expect((create.mock.calls[0] as unknown[])[0]).toEqual(
            expect.objectContaining({ activeKey: 'org-1:GITHUB:repo-1' }),
        );
        expect((create.mock.calls[1] as unknown[])[0]).toEqual(
            expect.objectContaining({ activeKey: 'org-1:GITLAB:repo-1' }),
        );
    });

    it("finds a repository's active and latest scans by its platform and id", async () => {
        const query = { select: jest.fn(), sort: jest.fn(), exec: jest.fn(async () => null) };
        query.select.mockReturnValue(query);
        query.sort.mockReturnValue(query);
        const findOne = jest.fn(() => query);
        const repository = new SecurityScanRepository({ findOne } as any);
        const gitlab = { platform: 'GITLAB', id: 'repo-1' };

        await repository.findActive('org-1', gitlab);
        await repository.findLatest('org-1', gitlab);

        for (const [filter] of findOne.mock.calls as unknown as [any][]) {
            expect(filter).toEqual(
                expect.objectContaining({
                    'organizationId': 'org-1',
                    'repository.platform': 'GITLAB',
                    'repository.id': 'repo-1',
                }),
            );
        }
        expect(findOne).toHaveBeenCalledTimes(2);
    });

    it('frees the key when the scan ends and appends what it reported in the same write', async () => {
        const findOneAndUpdate = jest.fn(() => exec({ _doc: { _id: 'id-1' } }));
        const repository = new SecurityScanRepository({ findOneAndUpdate } as any);
        const reported = [{ filePath: 'src/a.ts' }] as any;

        await repository.update('id-1', { status: 'completed' } as any, reported);
        await repository.update('id-1', { status: 'running' } as any);

        const [, ended] = findOneAndUpdate.mock.calls[0] as unknown as [string, any];
        // Ended: the key is freed and no job holds it any more.
        expect(ended).toEqual({
            $set: { status: 'completed' },
            $unset: { activeKey: '', runningJobId: '', leaseExpiresAt: '' },
            $push: { reported: { $each: reported } },
        });
        const [, running] = findOneAndUpdate.mock.calls[1] as unknown as [string, any];
        expect(running).toEqual({ $set: { status: 'running' } });
    });

    it('lets a job claim an active scan only when no other job holds a live claim', async () => {
        const findOneAndUpdate = jest.fn(() => exec(null));
        const repository = new SecurityScanRepository({ findOneAndUpdate } as any);
        const before = Date.now();

        await expect(repository.claim('id-1', 'job-2', 60_000)).resolves.toBeNull();

        const [filter, update] = findOneAndUpdate.mock.calls[0] as unknown as [any, any];
        expect(filter.status).toEqual({ $in: ['queued', 'running'] });
        expect(filter.$or).toEqual(
            expect.arrayContaining([
                { runningJobId: 'job-2' },
                { leaseExpiresAt: { $lt: expect.any(Date) } },
            ]),
        );
        expect(update.$set).toEqual(
            expect.objectContaining({ status: 'running', runningJobId: 'job-2' }),
        );
        expect(update.$set.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    });

    it('frees the claim when the scan is queued for its next job', async () => {
        const findOneAndUpdate = jest.fn(() => exec({ _doc: { _id: 'id-1' } }));
        const repository = new SecurityScanRepository({ findOneAndUpdate } as any);

        await repository.update('id-1', { status: 'queued' } as any);

        const [, update] = findOneAndUpdate.mock.calls[0] as unknown as [string, any];
        expect(update.$unset).toEqual({ runningJobId: '', leaseExpiresAt: '' });
    });

    it('changes a status only from the states it is given', async () => {
        const findOneAndUpdate = jest.fn(() => exec(null));
        const repository = new SecurityScanRepository({ findOneAndUpdate } as any);

        await expect(
            repository.update('id-1', { status: 'running' } as any, undefined, {
                statuses: ['queued', 'running'] as any,
                ownedBy: 'job-1',
            }),
        ).resolves.toBeNull();

        const [filter] = findOneAndUpdate.mock.calls[0] as unknown as [any];
        expect(filter).toEqual({
            _id: 'id-1',
            status: { $in: ['queued', 'running'] },
            runningJobId: 'job-1',
        });
    });

    it('frees the key of a scan it fails as stale', async () => {
        const updateMany = jest.fn(async () => ({ modifiedCount: 1 }));
        const repository = new SecurityScanRepository({ updateMany } as any);

        await repository.failStale('org-1', { runningMs: 60_000, queuedMs: 60_000 });

        const [, update] = updateMany.mock.calls[0] as unknown as [any, any];
        expect(update.$unset).toEqual({ activeKey: '' });
    });
});

describe('SecurityScanRepository.recordUnit', () => {
    const progress = { unitId: 'u1', state: 'done', findings: 1 } as any;
    const reported = [{ filePath: 'a.ts' }] as any;
    const updateOneReturning = (...matched: number[]) =>
        jest.fn(() => ({
            exec: jest.fn(async () => ({ matchedCount: matched.shift() ?? 1 })),
        }));

    it('appends a new area with the scan\'s other changes, guarded in the same write', async () => {
        const updateOne = updateOneReturning(1);
        const repository = new SecurityScanRepository({ updateOne } as any);

        await repository.recordUnit('scan-1', progress, { outcome: { created: 1 } } as any, reported);

        // One write: the check that the area has no entry is its filter.
        expect(updateOne).toHaveBeenCalledTimes(1);
        const [filter, update] = updateOne.mock.calls[0] as unknown as [any, any];
        expect(filter).toEqual({ '_id': 'scan-1', 'progress.unitId': { $ne: 'u1' } });
        expect(update.$set).toEqual({ outcome: { created: 1 } });
        expect(update.$push).toEqual({ progress, reported: { $each: reported } });
    });

    it("replaces the area's earlier entry in place when it has one", async () => {
        const updateOne = updateOneReturning(0, 1);
        const repository = new SecurityScanRepository({ updateOne } as any);

        await repository.recordUnit('scan-1', progress, { outcome: { created: 1 } } as any, reported);

        expect(updateOne).toHaveBeenCalledTimes(2);
        const [filter, update] = updateOne.mock.calls[1] as unknown as [any, any];
        expect(filter).toEqual({ '_id': 'scan-1', 'progress.unitId': 'u1' });
        expect(update.$set).toEqual({ 'outcome': { created: 1 }, 'progress.$': progress });
        expect(update.$push).toEqual({ reported: { $each: reported } });
    });

    it('removes a pending area', async () => {
        const updateOne = updateOneReturning(1);
        const repository = new SecurityScanRepository({ updateOne } as any);

        await repository.recordUnit('scan-1', { ...progress, state: 'pending' }, {});

        const [, update] = updateOne.mock.calls[0] as unknown as [any, any];
        expect(update.$pull).toEqual({ progress: { unitId: 'u1' } });
        expect(update.$push).toBeUndefined();
    });
});
