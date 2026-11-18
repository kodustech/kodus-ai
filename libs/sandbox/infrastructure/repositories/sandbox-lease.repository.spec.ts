import { SandboxLeaseRepository } from './sandbox-lease.repository';

const PR_KEY = '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo-1:7';

describe('SandboxLeaseRepository.upsertAcquire', () => {
    it('a joiner that needs longer pushes the expiry out; a shorter one never pulls it in', async () => {
        const findOneAndUpdate = jest.fn().mockResolvedValue({ _id: PR_KEY });
        const repo = new SandboxLeaseRepository({ findOneAndUpdate } as any);

        const before = Date.now();
        await repo.upsertAcquire(PR_KEY, 80 * 60 * 1000, 'review');

        const [, update, options] = findOneAndUpdate.mock.calls[0];
        // `$max` sets it on insert and only ever raises it on a join, so a
        // join no longer keeps the first acquire's expiry.
        expect(update.$setOnInsert.expiresAt).toBeUndefined();
        expect(update.$max.expiresAt.getTime()).toBeGreaterThanOrEqual(
            before + 80 * 60 * 1000,
        );
        expect(options).toMatchObject({ upsert: true });
    });
});
