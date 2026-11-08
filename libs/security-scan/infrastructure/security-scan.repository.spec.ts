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
    it('fails only queued or running scans silent for longer than the window', async () => {
        const updateMany = jest.fn(async () => ({ modifiedCount: 2 }));
        const repository = new SecurityScanRepository({ updateMany } as any);
        const before = Date.now();

        await expect(repository.failStale('org-1', 60_000)).resolves.toBe(2);

        const [filter, update] = updateMany.mock.calls[0] as unknown as [any, any];
        expect(filter.organizationId).toBe('org-1');
        expect(filter.status).toEqual({ $in: ['queued', 'running'] });
        expect(filter.updatedAt.$lt.getTime()).toBeLessThanOrEqual(before - 60_000 + 50);
        expect(update.$set.status).toBe('failed');
        expect(update.$set.error).toMatch(/Interrupted/);
    });
});
