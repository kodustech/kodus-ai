import { SandboxLeaseRepository } from './sandbox-lease.repository';

describe('SandboxLeaseRepository', () => {
    it('upsertAcquire refreshes expiresAt on existing leases so expired reaper claims go stale', async () => {
        const leaseModel = {
            findOneAndUpdate: jest.fn().mockResolvedValue({}),
        };
        const repo = new SandboxLeaseRepository(leaseModel as any);

        await repo.upsertAcquire(
            '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:199',
            60_000,
            'review',
        );

        expect(leaseModel.findOneAndUpdate).toHaveBeenCalledWith(
            { _id: '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:199' },
            [
                {
                    $set: expect.objectContaining({
                        consumer: 'review',
                        expiresAt: {
                            $cond: [
                                { $eq: ['$state', 'DELETING'] },
                                '$expiresAt',
                                expect.any(Date),
                            ],
                        },
                    }),
                },
            ],
            { upsert: true, new: true },
        );
    });

    it('upsertAcquire preserves expiresAt for DELETING leases so cleanup retries are not postponed', async () => {
        const leaseModel = {
            findOneAndUpdate: jest.fn().mockResolvedValue({}),
        };
        const repo = new SandboxLeaseRepository(leaseModel as any);

        await repo.upsertAcquire(
            '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:299',
            60_000,
            'review',
        );

        const [, update] = leaseModel.findOneAndUpdate.mock.calls[0];
        expect(Array.isArray(update)).toBe(true);
        expect(JSON.stringify(update)).toContain('"$cond"');
        expect(JSON.stringify(update)).toContain('"DELETING"');
        expect(JSON.stringify(update)).toContain('"$expiresAt"');
    });

    it('deleteIfNoActiveLeases returns true when the guarded delete removes a lease', async () => {
        const leaseModel = {
            deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
        };
        const repo = new SandboxLeaseRepository(leaseModel as any);

        await expect(
            repo.deleteIfNoActiveLeases(
                '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:200',
            ),
        ).resolves.toBe(true);

        expect(leaseModel.deleteOne).toHaveBeenCalledWith({
            _id: '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:200',
            leaseCount: { $lte: 0 },
        });
    });

    it('deleteIfNoActiveLeases returns false when an active lease blocks the delete', async () => {
        const leaseModel = {
            deleteOne: jest.fn().mockResolvedValue({ deletedCount: 0 }),
        };
        const repo = new SandboxLeaseRepository(leaseModel as any);

        await expect(
            repo.deleteIfNoActiveLeases(
                '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:201',
            ),
        ).resolves.toBe(false);
    });

    it('markDeletingIfNoActiveLeases blocks reuse only when no active leases remain', async () => {
        const leaseModel = {
            updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
        };
        const repo = new SandboxLeaseRepository(leaseModel as any);

        await expect(
            repo.markDeletingIfNoActiveLeases(
                '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:204',
            ),
        ).resolves.toBe(true);

        expect(leaseModel.updateOne).toHaveBeenCalledWith(
            {
                _id: '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:204',
                leaseCount: { $lte: 0 },
                state: { $in: ['READY', 'PAUSED', 'INVALIDATED', 'DELETING'] },
            },
            { $set: { state: 'DELETING' } },
        );
    });

    it('markDeletingIfReadyToKill claims an idle lease only when killAt still matches and no active leases remain', async () => {
        const leaseModel = {
            updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
        };
        const repo = new SandboxLeaseRepository(leaseModel as any);
        const killAt = new Date('2026-01-01T00:00:00.000Z');

        await expect(
            repo.markDeletingIfReadyToKill(
                '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:205',
                killAt,
            ),
        ).resolves.toBe(true);

        expect(leaseModel.updateOne).toHaveBeenCalledWith(
            {
                _id: '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:205',
                killAt,
                leaseCount: { $lte: 0 },
                sandboxId: { $exists: true, $ne: '' },
                state: { $in: ['READY', 'PAUSED', 'DELETING'] },
            },
            { $set: { state: 'DELETING' } },
        );
    });

    it('markDeletingIfExpired claims an expired lease by its original expiresAt', async () => {
        const leaseModel = {
            updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
        };
        const repo = new SandboxLeaseRepository(leaseModel as any);
        const expiresAt = new Date('2026-01-01T00:00:00.000Z');

        await expect(
            repo.markDeletingIfExpired(
                '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:207',
                expiresAt,
            ),
        ).resolves.toBe(true);

        expect(leaseModel.updateOne).toHaveBeenCalledWith(
            {
                _id: '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:207',
                expiresAt,
                state: {
                    $in: [
                        'CREATING',
                        'READY',
                        'PAUSED',
                        'INVALIDATED',
                        'DELETING',
                    ],
                },
            },
            { $set: { state: 'DELETING' } },
        );
    });

    it('markInvalidated blocks reuse for active READY or PAUSED leases', async () => {
        const leaseModel = {
            updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
        };
        const repo = new SandboxLeaseRepository(leaseModel as any);

        await expect(
            repo.markInvalidated(
                '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:206',
            ),
        ).resolves.toBe(true);

        expect(leaseModel.updateOne).toHaveBeenCalledWith(
            {
                _id: '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:206',
                state: { $in: ['CREATING', 'READY', 'PAUSED'] },
            },
            { $set: { state: 'INVALIDATED' } },
        );
    });

    it('clearKillAt preserves the retry cursor for DELETING leases', async () => {
        const leaseModel = {
            updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
        };
        const repo = new SandboxLeaseRepository(leaseModel as any);

        await repo.clearKillAt('7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:208');

        expect(leaseModel.updateOne).toHaveBeenCalledWith(
            {
                _id: '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:208',
                state: { $ne: 'DELETING' },
            },
            { $unset: { killAt: '' } },
        );
    });

    it('setKillAt returns true for an idempotent matched update', async () => {
        const leaseModel = {
            updateOne: jest.fn().mockResolvedValue({
                matchedCount: 1,
                modifiedCount: 0,
            }),
        };
        const repo = new SandboxLeaseRepository(leaseModel as any);
        const killAt = new Date('2026-01-01T00:00:00.000Z');

        await expect(
            repo.setKillAt(
                '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:202',
                killAt,
            ),
        ).resolves.toBe(true);

        expect(leaseModel.updateOne).toHaveBeenCalledWith(
            {
                _id: '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:202',
                leaseCount: { $lte: 0 },
                sandboxId: { $exists: true, $ne: '' },
            },
            { $set: { killAt } },
        );
    });

    it('setKillAt returns false when no inactive lease matched the guard', async () => {
        const leaseModel = {
            updateOne: jest.fn().mockResolvedValue({
                matchedCount: 0,
                modifiedCount: 0,
            }),
        };
        const repo = new SandboxLeaseRepository(leaseModel as any);

        await expect(
            repo.setKillAt(
                '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo:203',
                new Date('2026-01-01T00:00:00.000Z'),
            ),
        ).resolves.toBe(false);
    });

    it('findExpired applies an explicit query limit', async () => {
        const query = {
            select: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue([]),
        };
        const leaseModel = {
            find: jest.fn().mockReturnValue(query),
        };
        const repo = new SandboxLeaseRepository(leaseModel as any);
        const now = new Date('2026-01-01T00:00:00.000Z');

        await expect(repo.findExpired(now, 25)).resolves.toEqual([]);

        expect(leaseModel.find).toHaveBeenCalledWith({
            expiresAt: { $lt: now },
        });
        expect(query.select).toHaveBeenCalledWith(
            '_id sandboxId state expiresAt',
        );
        expect(query.limit).toHaveBeenCalledWith(25);
        expect(query.lean).toHaveBeenCalledTimes(1);
    });

    it('findReadyToKill applies an explicit query limit', async () => {
        const query = {
            select: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue([]),
        };
        const leaseModel = {
            find: jest.fn().mockReturnValue(query),
        };
        const repo = new SandboxLeaseRepository(leaseModel as any);
        const now = new Date('2026-01-01T00:00:00.000Z');

        await expect(repo.findReadyToKill(now, 25)).resolves.toEqual([]);

        expect(leaseModel.find).toHaveBeenCalledWith({
            killAt: { $lte: now },
            sandboxId: { $exists: true, $ne: '' },
        });
        expect(query.select).toHaveBeenCalledWith('_id sandboxId killAt');
        expect(query.limit).toHaveBeenCalledWith(25);
        expect(query.lean).toHaveBeenCalledTimes(1);
    });
});
