import { SandboxLeaseRepository } from './sandbox-lease.repository';
import { SANDBOX_LEASE_CLEANUP_STATUS } from './schemas/sandbox-lease.model';

/**
 * The single-use release relies on the claim and `killAt` landing in one
 * MongoDB write: `findReadyToKill` only reads `killAt`, so a claim without
 * it would keep the sandbox billing until the lease TTL (#2626).
 *
 * These cases stub the model itself, so dropping `killAt` from the `$set`
 * (or adding a separate write) fails here even though the lease-manager
 * specs mock `claimCleanup` whole.
 */
describe('SandboxLeaseRepository.claimCleanup', () => {
    const build = () => {
        const exec = jest.fn().mockResolvedValue({ _id: 'lease' });
        const findOneAndUpdate = jest.fn().mockReturnValue({ exec });
        const repo = new SandboxLeaseRepository({
            findOneAndUpdate,
        } as any);
        return { repo, findOneAndUpdate };
    };

    it('stores killAt in the same $set as the cleanup claim', async () => {
        const { repo, findOneAndUpdate } = build();
        const killAt = new Date('2026-11-22T12:00:00.000Z');

        await repo.claimCleanup('org:repo:1', 'sbx-1', true, killAt);

        expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
        const [filter, update] = findOneAndUpdate.mock.calls[0];
        expect(filter).toMatchObject({
            _id: 'org:repo:1',
            sandboxId: 'sbx-1',
            leaseCount: { $lte: 0 },
        });
        expect(update.$set).toMatchObject({
            cleanupStatus: SANDBOX_LEASE_CLEANUP_STATUS.IN_PROGRESS,
            killAt,
        });
    });

    it('leaves killAt out when the caller does not pass one', async () => {
        const { repo, findOneAndUpdate } = build();

        await repo.claimCleanup('org:repo:1', 'sbx-1', false);

        const [filter, update] = findOneAndUpdate.mock.calls[0];
        expect(filter).not.toHaveProperty('leaseCount');
        expect(update.$set).not.toHaveProperty('killAt');
    });
});
