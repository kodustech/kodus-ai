import type { ClaimState } from '@libs/runtime/contracts/enums';
import { ImageStoreConfigSchema } from '@libs/runtime/fleet/image-store';
import { FakeImageStoreProvider } from '@libs/runtime/fleet/testing';

import type { CellSession } from '../hub-store';
import { InMemoryImageStoreBook } from '../testing';
import { ImageStoreService, type PreparedImageStore } from './image-store.service';

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
        const prepared = (await ctx.service.prepare(session, ask, { claimId: 'shard-0', cellId: 'cell-s' })) as PreparedImageStore | undefined;
        expect(prepared?.prImages).toEqual([{ fingerprint: image.fingerprint, digest: image.digest }]);
        expect(ctx.polls()).toBe(2);
        expect(ctx.outcomes).toEqual(['waited_ready']);
    });

    it('does not wait at all when no builder asked to push this PR: the shard builds as it does today', async () => {
        const ctx = setup();
        const prepared = (await ctx.service.prepare(session, ask, { claimId: 'shard-0', cellId: 'cell-s' })) as PreparedImageStore | undefined;
        expect(prepared?.grant).toBeDefined();
        expect(prepared?.prImages).toBeUndefined();
        expect(ctx.polls()).toBe(0);
    });

    it('stops waiting and builds when the builder reports the push failed', async () => {
        const ctx = setup();
        await ctx.pending();
        await ctx.book.finishPrImage({ orgId: 'org', environmentId: 'env', prSha: SHA, builderClaim: 'builder', state: 'failed', images: [], reason: 'secret_in_image' });
        const prepared = (await ctx.service.prepare(session, ask, { claimId: 'shard-0', cellId: 'cell-s' })) as PreparedImageStore | undefined;
        expect(prepared?.prImages).toBeUndefined();
        expect(ctx.outcomes).toEqual(['failed']);
    });

    it('stops waiting when the builder claim ended without telling anyone (a lease sweep): the row is failed and the shard builds', async () => {
        const ctx = setup();
        await ctx.pending();
        ctx.onPoll((n) => {
            if (n === 1) ctx.claims.set('builder', 'terminated');
        });
        const prepared = (await ctx.service.prepare(session, ask, { claimId: 'shard-0', cellId: 'cell-s' })) as PreparedImageStore | undefined;
        expect(prepared?.prImages).toBeUndefined();
        expect((await ctx.book.prImage('org', 'env', SHA))?.state).toBe('failed');
    });

    it('stops waiting at the cap even when the builder is still alive, and builds', async () => {
        const ctx = setup({ waitMs: 3 * 60_000 });
        await ctx.pending();
        const prepared = (await ctx.service.prepare(session, ask, { claimId: 'shard-0', cellId: 'cell-s' })) as PreparedImageStore | undefined;
        expect(prepared?.prImages).toBeUndefined();
        expect(ctx.polls()).toBe(3);
        expect(ctx.outcomes).toEqual(['waited_timeout']);
    });

    it('never takes a digest another org pushed for the same sha', async () => {
        const ctx = setup();
        await ctx.book.startPrImage({ orgId: 'other', environmentId: 'env', prSha: SHA, builderClaim: 'x', expiresAt: '2099-01-01T00:00:00.000Z' });
        await ctx.book.finishPrImage({ orgId: 'other', environmentId: 'env', prSha: SHA, builderClaim: 'x', state: 'ready', images: [image] });
        const prepared = (await ctx.service.prepare(session, ask, { claimId: 'shard-0', cellId: 'cell-s' })) as PreparedImageStore | undefined;
        expect(prepared?.prImages).toBeUndefined();
    });
});

// A Run's suite shard asks to wait for the PR image (`awaitPrImage`): the PR side is building it on its own machine, so a shard never
// rebuilds the PR in parallel. A failed image is a refusal with its cause, not a second build (docs/runtime/e2e-suites.md 10.2).
describe('a Run-mode shard that must wait for the PR image', () => {
    const run = { ...ask, awaitPrImage: true };

    it('waits for a builder that has not started yet, then for its image, and boots from the pull', async () => {
        const ctx = setup();
        ctx.onPoll((n) => {
            if (n === 1) void ctx.pending();
            if (n === 3) void ctx.book.finishPrImage({ orgId: 'org', environmentId: 'env', prSha: SHA, builderClaim: 'builder', state: 'ready', images: [image] });
        });
        const prepared = await ctx.service.prepare(session, run, { claimId: 'shard-0', cellId: 'cell-s' });
        expect(prepared).toMatchObject({ prImages: [{ fingerprint: image.fingerprint, digest: image.digest }] });
    });

    it('takes an image published late, inside the cap', async () => {
        const ctx = setup({ waitMs: 20 * 60_000 });
        await ctx.pending();
        ctx.onPoll((n) => {
            if (n === 15) void ctx.book.finishPrImage({ orgId: 'org', environmentId: 'env', prSha: SHA, builderClaim: 'builder', state: 'ready', images: [image] });
        });
        const prepared = await ctx.service.prepare(session, run, { claimId: 'shard-0', cellId: 'cell-s' });
        expect(prepared).toMatchObject({ prImages: [{ digest: image.digest }] });
        expect(ctx.polls()).toBe(15);
    });

    it('refuses with the cause when the push failed, mints no credential and does not build', async () => {
        const ctx = setup();
        await ctx.pending();
        await ctx.book.finishPrImage({ orgId: 'org', environmentId: 'env', prSha: SHA, builderClaim: 'builder', state: 'failed', images: [], reason: 'push_failed' });
        const prepared = await ctx.service.prepare(session, run, { claimId: 'shard-0', cellId: 'cell-s' });
        expect(prepared).toEqual({ unavailable: 'push_failed' });
        expect(await ctx.book.grantOf('shard-0')).toBeNull();
    });

    it('refuses when the builder ended without an image', async () => {
        const ctx = setup();
        await ctx.pending();
        ctx.claims.set('builder', 'terminated');
        const prepared = await ctx.service.prepare(session, run, { claimId: 'shard-0', cellId: 'cell-s' });
        expect(prepared).toEqual({ unavailable: 'builder_ended' });
    });

    it('refuses at the cap when the image never comes', async () => {
        const ctx = setup({ waitMs: 3 * 60_000 });
        await ctx.pending();
        expect(await ctx.service.prepare(session, run, { claimId: 'shard-0', cellId: 'cell-s' })).toEqual({ unavailable: 'wait_timeout' });
    });

    it('refuses when no PR side ever asked to push, after the cap', async () => {
        const ctx = setup({ waitMs: 2 * 60_000 });
        expect(await ctx.service.prepare(session, run, { claimId: 'shard-0', cellId: 'cell-s' })).toEqual({ unavailable: 'no_pr_image' });
    });

    it('takes a builder that restarts a row an earlier attempt left failed (builder_ended) instead of refusing on the stale row', async () => {
        const ctx = setup();
        await ctx.pending();
        await ctx.book.failPendingOf('builder', 'builder_ended');
        ctx.onPoll((n) => {
            if (n === 1) {
                void ctx.book.startPrImage({ orgId: 'org', environmentId: 'env', prSha: SHA, builderClaim: 'builder2', expiresAt: '2099-01-01T00:00:00.000Z' });
                ctx.claims.set('builder2', 'bound');
            }
            if (n === 2) void ctx.book.finishPrImage({ orgId: 'org', environmentId: 'env', prSha: SHA, builderClaim: 'builder2', state: 'ready', images: [image] });
        });
        const prepared = await ctx.service.prepare(session, run, { claimId: 'shard-0', cellId: 'cell-s' });
        expect(prepared).toMatchObject({ prImages: [{ digest: image.digest }] });
    });

    it('still builds when the PR side built nothing (its images were already in the host)', async () => {
        const ctx = setup();
        await ctx.pending();
        await ctx.book.finishPrImage({ orgId: 'org', environmentId: 'env', prSha: SHA, builderClaim: 'builder', state: 'failed', images: [], reason: 'nothing_built' });
        const prepared = await ctx.service.prepare(session, run, { claimId: 'shard-0', cellId: 'cell-s' });
        expect(prepared).toMatchObject({ grant: expect.anything() });
    });
});

// The PR side's push credential lives 10 minutes by default and its build takes longer: the hub renews it while the claim boots,
// because the owner's claim.renew only reaches a bound claim (e2ac9ffd: renewals 0, the push found the token expired, push_failed).
describe('the credential of a claim that is still booting', () => {
    afterEach(() => jest.useRealTimers());

    it('is renewed on a timer until the claim is ready, and not after', async () => {
        jest.useFakeTimers();
        const ctx = setup();
        const writer = { ...ask, consumer: 'runtime', ref: { side: 'pr' as const, sha: SHA } };
        const bk = { ...session, boundKey: 'run:org/run-1' };
        const prepared = (await ctx.service.prepare(bk, writer, { claimId: 'pr-claim', cellId: 'cell-s' })) as PreparedImageStore | undefined;
        expect(prepared?.grant).toBeDefined();
        const sent: unknown[] = [];
        const stop = ctx.service.keepFresh('pr-claim', bk, async (g) => void sent.push(g));
        await jest.advanceTimersByTimeAsync(5 * 60_000 + 1);
        const whileBooting = sent.length;
        expect(whileBooting).toBeGreaterThanOrEqual(2);
        stop();
        await jest.advanceTimersByTimeAsync(10 * 60_000);
        expect(sent.length).toBe(whileBooting);
        expect((await ctx.book.grantOf('pr-claim'))?.renewals).toBe(whileBooting);
    });
});
