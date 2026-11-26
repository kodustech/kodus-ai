import {
    MAX_LEASE_LIFETIME_MS,
    SandboxLeaseRepository,
} from './sandbox-lease.repository';
import { SANDBOX_LEASE_CLEANUP_STATUS } from './schemas/sandbox-lease.model';

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

    it('a READY lease in use gets the whole TTL its joiner asks for, however old it is', async () => {
        const { repo, docs } = setup({
            state: 'READY',
            expiresInMs: minute,
            createdAgoMs: MAX_LEASE_LIFETIME_MS - 5 * minute,
        });
        await repo.upsertAcquire(PR_KEY, 80 * minute, 'review');
        expect(expiresIn(docs)).toBeGreaterThan(79 * minute);
    });

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

/**
 * A release reads leaseCount 0 and writes killAt in two steps. A holder that
 * joins in between clears killAt first, so the late write must not land, and
 * the idle-kill cron must never pick a held lease (#2628). Reproduced on real
 * MongoDB before this change: the joiner's lease ended with leaseCount 1 and a
 * killAt that findReadyToKill returned.
 */
describe('SandboxLeaseRepository idle-kill on a held lease', () => {
    it('setKillAt only matches a lease nobody holds, and says whether it did', async () => {
        const updateOne = jest
            .fn()
            .mockResolvedValueOnce({ matchedCount: 0 })
            .mockResolvedValueOnce({ matchedCount: 1 });
        const repo = new SandboxLeaseRepository({ updateOne } as any);
        const killAt = new Date('2026-11-26T12:00:00.000Z');

        await expect(repo.setKillAt(PR_KEY, killAt)).resolves.toBe(false);
        await expect(repo.setKillAt(PR_KEY, killAt)).resolves.toBe(true);

        const [filter, update] = updateOne.mock.calls[0];
        expect(filter).toEqual({
            _id: PR_KEY,
            sandboxId: { $exists: true, $ne: '' },
            leaseCount: { $not: { $gt: 0 } },
        });
        expect(update).toEqual({ $set: { killAt } });
    });

    it('findReadyToKill skips a held lease', async () => {
        const lean = jest.fn().mockResolvedValue([]);
        const select = jest.fn().mockReturnValue({ lean });
        const find = jest.fn().mockReturnValue({ select });
        const repo = new SandboxLeaseRepository({ find } as any);

        const now = new Date();
        await repo.findReadyToKill(now);

        expect(find.mock.calls[0][0]).toEqual({
            killAt: { $lte: now },
            sandboxId: { $exists: true, $ne: '' },
            leaseCount: { $not: { $gt: 0 } },
        });
    });
});

/**
 * findReadyToKill is a read: a holder can join between it and the kill. The
 * cron takes the lease off its prKey only while it is still idle, and kills
 * against a retired doc no acquire matches (#2628).
 */
describe('SandboxLeaseRepository.detachIdle', () => {
    const build = (deleted: { killRetryCount?: number } | null) => {
        const lean = jest.fn().mockResolvedValue(deleted);
        const select = jest.fn().mockReturnValue({ lean });
        const findOneAndDelete = jest.fn().mockReturnValue({ select });
        const updateOne = jest.fn().mockResolvedValue({ matchedCount: 0 });
        const repo = new SandboxLeaseRepository({
            findOneAndDelete,
            updateOne,
        } as any);
        return { repo, findOneAndDelete, updateOne };
    };
    const now = new Date('2026-11-26T12:00:00.000Z');
    const ORG = PR_KEY.split(':')[0];

    it('detaches an idle lease onto a retired doc and returns its id', async () => {
        const { repo, findOneAndDelete, updateOne } = build({
            killRetryCount: 2,
        });

        await expect(repo.detachIdle(PR_KEY, 'sbx-1', now)).resolves.toBe(
            `${ORG}:retired:sbx-1`,
        );

        expect(findOneAndDelete.mock.calls[0][0]).toEqual({
            _id: PR_KEY,
            sandboxId: 'sbx-1',
            killAt: { $lte: now },
            leaseCount: { $not: { $gt: 0 } },
        });
        expect(updateOne.mock.calls[0]).toEqual([
            { _id: `${ORG}:retired:sbx-1` },
            {
                $setOnInsert: {
                    sandboxId: 'sbx-1',
                    state: 'READY',
                    leaseCount: 0,
                    createdAt: now,
                    expiresAt: now,
                    killAt: now,
                    organizationId: ORG,
                    killRetryCount: 2,
                },
            },
            { upsert: true },
        ]);
    });

    it('returns null and writes nothing when a holder joined', async () => {
        const { repo, updateOne } = build(null);

        await expect(repo.detachIdle(PR_KEY, 'sbx-1', now)).resolves.toBe(null);
        expect(updateOne).not.toHaveBeenCalled();
    });

    it('returns a retired doc as is', async () => {
        const { repo, findOneAndDelete } = build(null);

        await expect(
            repo.detachIdle(`${ORG}:retired:sbx-1`, 'sbx-1', now),
        ).resolves.toBe(`${ORG}:retired:sbx-1`);
        expect(findOneAndDelete).not.toHaveBeenCalled();
    });
});
