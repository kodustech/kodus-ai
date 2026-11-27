import type { ClaimState } from '@libs/runtime/contracts/enums';
import { ImageStoreConfigSchema } from '@libs/runtime/fleet/image-store';
import { FakeImageStoreProvider } from '@libs/runtime/fleet/testing';

import type { CellSession } from '../hub-store';
import { InMemoryImageStoreBook } from '../testing';
import { ImageStoreService } from './image-store.service';

// The shard's wait for the PR image its builder pushes (docs/runtime/shared-image-store.md sections 5 and 6).

const SHA = 'a'.repeat(40);
const session: CellSession = { cellId: 'cell-s', replicaId: 'r', replicaUrl: 'http://r', owner: 'kodus', driver: 'docker-gvisor', features: ['imageStore'], poolId: 'boat', boundKey: 'suite:org/s1/0' };
const ask = { organizationId: 'org', environmentId: 'env', consumer: 'suite', ref: { side: 'pr' as const, sha: SHA } };
const image = { fingerprint: 'f'.repeat(64), digest: `sha256:${'d'.repeat(64)}`, bytes: 1, pushMs: 1 };

function setup(over: { waitMs?: number } = {}) {
    const book = new InMemoryImageStoreBook();
    const claims = new Map<string, ClaimState>([['builder', 'bound']]);
    const outcomes: string[] = [];
    let now = Date.parse('2026-11-27T12:00:00.000Z');
    // Each poll lets a minute pass, and runs `onPoll`, which is where the builder does its work.
    let onPoll = (_n: number) => {};
    let polls = 0;
    const service = new ImageStoreService({
        book,
        pools: { imageStoreOf: async () => ImageStoreConfigSchema.parse({ provider: 'fake' }) },
        providerFor: () => new FakeImageStoreProvider(),
        claimState: async (id) => claims.get(id) ?? null,
        metrics: { imageStoreGrant: () => undefined, imageStorePrImage: (o) => void outcomes.push(o) },
        log: () => undefined,
        now: () => new Date(now),
        waitMs: over.waitMs ?? 10 * 60_000,
        sleep: async () => {
            now += 60_000;
            onPoll(++polls);
        },
    });
    const pending = () => book.startPrImage({ orgId: 'org', environmentId: 'env', prSha: SHA, builderClaim: 'builder', expiresAt: '2099-01-01T00:00:00.000Z' });
    return { service, book, claims, outcomes, pending, onPoll: (f: (n: number) => void) => void (onPoll = f), polls: () => polls };
}

describe('a suite shard waiting for its PR image', () => {
    it('waits while the builder is pushing and takes the digest the moment it is ready', async () => {
        const ctx = setup();
        await ctx.pending();
        ctx.onPoll((n) => {
            if (n === 2) void ctx.book.finishPrImage({ orgId: 'org', environmentId: 'env', prSha: SHA, builderClaim: 'builder', state: 'ready', images: [image] });
        });
        const prepared = await ctx.service.prepare(session, ask, { claimId: 'shard-0', cellId: 'cell-s' });
        expect(prepared?.prImages).toEqual([{ fingerprint: image.fingerprint, digest: image.digest }]);
        expect(ctx.polls()).toBe(2);
        expect(ctx.outcomes).toEqual(['waited_ready']);
    });

    it('does not wait at all when no builder asked to push this PR: the shard builds as it does today', async () => {
        const ctx = setup();
        const prepared = await ctx.service.prepare(session, ask, { claimId: 'shard-0', cellId: 'cell-s' });
        expect(prepared?.grant).toBeDefined();
        expect(prepared?.prImages).toBeUndefined();
        expect(ctx.polls()).toBe(0);
    });

    it('stops waiting and builds when the builder reports the push failed', async () => {
        const ctx = setup();
        await ctx.pending();
        await ctx.book.finishPrImage({ orgId: 'org', environmentId: 'env', prSha: SHA, builderClaim: 'builder', state: 'failed', images: [], reason: 'secret_in_image' });
        const prepared = await ctx.service.prepare(session, ask, { claimId: 'shard-0', cellId: 'cell-s' });
        expect(prepared?.prImages).toBeUndefined();
        expect(ctx.outcomes).toEqual(['failed']);
    });

    it('stops waiting when the builder claim ended without telling anyone (a lease sweep): the row is failed and the shard builds', async () => {
        const ctx = setup();
        await ctx.pending();
        ctx.onPoll((n) => {
            if (n === 1) ctx.claims.set('builder', 'terminated');
        });
        const prepared = await ctx.service.prepare(session, ask, { claimId: 'shard-0', cellId: 'cell-s' });
        expect(prepared?.prImages).toBeUndefined();
        expect((await ctx.book.prImage('org', 'env', SHA))?.state).toBe('failed');
    });

    it('stops waiting at the cap even when the builder is still alive, and builds', async () => {
        const ctx = setup({ waitMs: 3 * 60_000 });
        await ctx.pending();
        const prepared = await ctx.service.prepare(session, ask, { claimId: 'shard-0', cellId: 'cell-s' });
        expect(prepared?.prImages).toBeUndefined();
        expect(ctx.polls()).toBe(3);
        expect(ctx.outcomes).toEqual(['waited_timeout']);
    });

    it('never takes a digest another org pushed for the same sha', async () => {
        const ctx = setup();
        await ctx.book.startPrImage({ orgId: 'other', environmentId: 'env', prSha: SHA, builderClaim: 'x', expiresAt: '2099-01-01T00:00:00.000Z' });
        await ctx.book.finishPrImage({ orgId: 'other', environmentId: 'env', prSha: SHA, builderClaim: 'x', state: 'ready', images: [image] });
        const prepared = await ctx.service.prepare(session, ask, { claimId: 'shard-0', cellId: 'cell-s' });
        expect(prepared?.prImages).toBeUndefined();
    });
});
