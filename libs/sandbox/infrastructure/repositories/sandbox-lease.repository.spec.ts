import { SandboxLeaseRepository } from './sandbox-lease.repository';

const PR_KEY = '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo-1:7';
const minute = 60 * 1000;

const setup = (existing: { state: string; expiresInMs: number } | null) => {
    const docs = new Map<string, any>();
    if (existing) {
        docs.set(PR_KEY, {
            _id: PR_KEY,
            state: existing.state,
            leaseCount: 1,
            expiresAt: new Date(Date.now() + existing.expiresInMs),
        });
    }
    // A Mongo stand-in for the two updates upsertAcquire makes.
    const findOneAndUpdate = jest.fn(async (filter: any, update: any) => {
        const doc = docs.get(filter._id);
        if (update.$setOnInsert) {
            const next = doc ?? { _id: filter._id, ...update.$setOnInsert };
            next.leaseCount = (next.leaseCount ?? 0) + 1;
            docs.set(filter._id, next);
            return { ...next };
        }
        if (
            !doc ||
            !filter.state.$in.includes(doc.state) ||
            !(doc.expiresAt < filter.expiresAt.$lt)
        ) {
            return null;
        }
        doc.expiresAt = update.$set.expiresAt;
        return { ...doc };
    });
    return {
        repo: new SandboxLeaseRepository({ findOneAndUpdate } as any),
        docs,
    };
};

describe('SandboxLeaseRepository.upsertAcquire', () => {
    it('a joiner that needs longer pushes a live lease out', async () => {
        const { repo, docs } = setup({ state: 'READY', expiresInMs: minute });
        await repo.upsertAcquire(PR_KEY, 80 * minute, 'review');
        expect(docs.get(PR_KEY).expiresAt.getTime()).toBeGreaterThan(
            Date.now() + 79 * minute,
        );
    });

    it('a shorter joiner never pulls it in', async () => {
        const { repo, docs } = setup({
            state: 'READY',
            expiresInMs: 80 * minute,
        });
        await repo.upsertAcquire(PR_KEY, 30 * minute, 'review');
        expect(docs.get(PR_KEY).expiresAt.getTime()).toBeGreaterThan(
            Date.now() + 79 * minute,
        );
    });

    it.each(['CREATING', 'INVALIDATED'])(
        'a %s lease keeps its expiry, so the reaper still clears it',
        async (state) => {
            const { repo, docs } = setup({ state, expiresInMs: minute });
            await repo.upsertAcquire(PR_KEY, 80 * minute, 'review');
            expect(docs.get(PR_KEY).expiresAt.getTime()).toBeLessThan(
                Date.now() + 2 * minute,
            );
        },
    );

    it('a new lease is created with the TTL asked for', async () => {
        const { repo, docs } = setup(null);
        await repo.upsertAcquire(PR_KEY, 80 * minute, 'review');
        expect(docs.get(PR_KEY).state).toBe('CREATING');
        expect(docs.get(PR_KEY).expiresAt.getTime()).toBeGreaterThan(
            Date.now() + 79 * minute,
        );
    });
});
