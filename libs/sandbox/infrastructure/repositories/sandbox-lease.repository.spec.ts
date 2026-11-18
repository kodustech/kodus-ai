import {
    MAX_LEASE_LIFETIME_MS,
    SandboxLeaseRepository,
} from './sandbox-lease.repository';

const PR_KEY = '7e2e97b8-aefa-422e-92d4-30b378c0332e:repo-1:7';
const minute = 60 * 1000;

const setup = (
    existing: {
        state: string;
        expiresInMs: number;
        createdAgoMs?: number;
    } | null,
) => {
    const docs = new Map<string, any>();
    if (existing) {
        docs.set(PR_KEY, {
            _id: PR_KEY,
            state: existing.state,
            leaseCount: 1,
            createdAt: new Date(Date.now() - (existing.createdAgoMs ?? 0)),
            expiresAt: new Date(Date.now() + existing.expiresInMs),
        });
    }
    // A Mongo stand-in for findOneAndUpdate: filters on _id, state ($in) and
    // expiresAt ($lt); applies $setOnInsert (with upsert), $set, $max, $inc.
    const findOneAndUpdate = jest.fn(
        async (filter: any, update: any, options: any = {}) => {
            let doc = docs.get(filter._id);
            const matches =
                !!doc &&
                (!filter.state || filter.state.$in.includes(doc.state)) &&
                (!filter.expiresAt || doc.expiresAt < filter.expiresAt.$lt);
            if (!matches) {
                if (doc || !options.upsert) return null;
                doc = { _id: filter._id, ...update.$setOnInsert };
                docs.set(filter._id, doc);
            }
            Object.assign(doc, update.$set ?? {});
            for (const [k, v] of Object.entries(update.$max ?? {})) {
                if (!(doc[k] >= (v as any))) doc[k] = v;
            }
            for (const [k, v] of Object.entries(update.$inc ?? {})) {
                doc[k] = (doc[k] ?? 0) + (v as number);
            }
            return { ...doc };
        },
    );
    return {
        repo: new SandboxLeaseRepository({ findOneAndUpdate } as any),
        docs,
    };
};

const expiresIn = (docs: Map<string, any>) =>
    docs.get(PR_KEY).expiresAt.getTime() - Date.now();

describe('SandboxLeaseRepository.upsertAcquire', () => {
    it.each(['READY', 'CREATING'])(
        'a joiner that needs longer pushes a %s lease out',
        async (state) => {
            const { repo, docs } = setup({ state, expiresInMs: minute });
            await repo.upsertAcquire(PR_KEY, 80 * minute, 'review');
            expect(expiresIn(docs)).toBeGreaterThan(79 * minute);
        },
    );

    it('a shorter joiner never pulls it in', async () => {
        const { repo, docs } = setup({
            state: 'READY',
            expiresInMs: 80 * minute,
        });
        await repo.upsertAcquire(PR_KEY, 30 * minute, 'review');
        expect(expiresIn(docs)).toBeGreaterThan(79 * minute);
    });

    it('an INVALIDATED lease keeps its expiry, so the reaper still clears it', async () => {
        const { repo, docs } = setup({
            state: 'INVALIDATED',
            expiresInMs: minute,
        });
        await repo.upsertAcquire(PR_KEY, 80 * minute, 'review');
        expect(expiresIn(docs)).toBeLessThan(2 * minute);
    });

    it('a lease stuck CREATING is never pushed past its lifetime, however often it is joined', async () => {
        const { repo, docs } = setup({
            state: 'CREATING',
            expiresInMs: minute,
            createdAgoMs: MAX_LEASE_LIFETIME_MS - 5 * minute,
        });
        await repo.upsertAcquire(PR_KEY, 80 * minute, 'review');
        await repo.upsertAcquire(PR_KEY, 80 * minute, 'review');
        expect(expiresIn(docs)).toBeLessThanOrEqual(5 * minute + 1_000);
    });

    it('a new lease is created with the TTL asked for', async () => {
        const { repo, docs } = setup(null);
        await repo.upsertAcquire(PR_KEY, 80 * minute, 'review');
        expect(docs.get(PR_KEY).state).toBe('CREATING');
        expect(expiresIn(docs)).toBeGreaterThan(79 * minute);
    });
});
