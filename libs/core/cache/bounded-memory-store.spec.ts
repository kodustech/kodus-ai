import { createCache } from 'cache-manager';
import { Keyv } from 'keyv';

import {
    BoundedMemoryStore,
    SMALL_ENTRY_BYTES,
    sizeOf,
} from './bounded-memory-store';

/**
 * The global cache must stay bounded whatever keys it gets: the GitHub client
 * caches file contents under blob-sha keys that are almost never read again.
 */
describe('BoundedMemoryStore', () => {
    const bounds = { maxEntries: 100, maxBytes: 50_000, maxEntryBytes: 20_000 };

    it('keeps the cache bounded under keys that are never read again', async () => {
        const store = new BoundedMemoryStore(bounds);
        const cache = createCache({ stores: [new Keyv({ store })] });
        const file = 'x'.repeat(4_000);

        // A day of reviews: every commit brings new blob shas.
        for (let i = 0; i < 2_000; i++) {
            await cache.set(
                `gh:contents:org/repo:${i}:src/a.ts`,
                file,
                86_400_000,
            );
        }

        expect(store.size).toBeLessThanOrEqual(bounds.maxEntries);
        expect(store.heldBytes).toBeLessThanOrEqual(bounds.maxBytes);
        // The newest entry is still served.
        expect(await cache.get('gh:contents:org/repo:1999:src/a.ts')).toBe(
            file,
        );
        // The oldest was evicted.
        expect(
            await cache.get('gh:contents:org/repo:0:src/a.ts'),
        ).toBeUndefined();
    });

    it('evicts by count when values are small', () => {
        const store = new BoundedMemoryStore(bounds);
        for (let i = 0; i < 500; i++) store.set(`k${i}`, 'v');
        expect(store.size).toBe(bounds.maxEntries);
        expect(store.has('k0')).toBe(false);
        expect(store.has('k499')).toBe(true);
    });

    it('does not cache one value larger than the per-entry cap', () => {
        const store = new BoundedMemoryStore(bounds);
        store.set('small', 'v');
        store.set('huge', 'x'.repeat(bounds.maxEntryBytes + 1));
        store.set('at-cap', 'x'.repeat(bounds.maxEntryBytes));
        expect(store.has('huge')).toBe(false);
        expect(store.has('at-cap')).toBe(true);
        expect(store.has('small')).toBe(true);
    });

    it('re-setting a key replaces its size instead of adding to it', () => {
        const store = new BoundedMemoryStore(bounds);
        store.set('a', 'x'.repeat(1_000));
        store.set('a', 'x'.repeat(10));
        expect(store.heldBytes).toBe(10);
        store.delete('a');
        expect(store.heldBytes).toBe(0);
    });

    // Rate limiters and the BYOK error counter keep state in this cache and
    // read it on every event; file contents are read about once.
    it('keeps a key that is read while new entries pour in', () => {
        const store = new BoundedMemoryStore(bounds);
        store.set('limiter:org-1', 'count');
        for (let i = 0; i < 500; i++) {
            store.set(`gh:contents:${i}`, 'v');
            if (i % 50 === 0) expect(store.get('limiter:org-1')).toBe('count');
        }
        expect(store.get('limiter:org-1')).toBe('count');
        expect(store.size).toBe(100);
    });

    it('evicts a key nobody reads, in insertion order', () => {
        const store = new BoundedMemoryStore(bounds);
        store.set('limiter:org-1', 'count');
        for (let i = 0; i < 100; i++) store.set(`gh:contents:${i}`, 'v');
        expect(store.has('limiter:org-1')).toBe(false);
        expect(store.heldBytes).toBe(100);
    });

    // validate-prerequisites dedupes the "review skipped (no license)" notice
    // at one per author per day through this cache. Evicted along with the
    // file contents, the author got it again every few hours.
    it('keeps a small flag while large values pour through', async () => {
        const store = new BoundedMemoryStore(bounds);
        const cache = createCache({ stores: [new Keyv({ store })] });
        await cache.set(
            'notif-rate:review_skipped_no_license:org:author',
            true,
            86_400_000,
        );

        for (let i = 0; i < 2_000; i++) {
            await cache.set(`gh:contents:${i}`, 'x'.repeat(4_000), 86_400_000);
        }

        expect(
            await cache.get('notif-rate:review_skipped_no_license:org:author'),
        ).toBe(true);
        expect(store.heldBytes).toBeLessThanOrEqual(bounds.maxBytes);
        expect(await cache.get('gh:contents:0')).toBeUndefined();
    });

    describe('a flag that must last its TTL (#2744 QA)', () => {
        const FLAG = 'notif-rate:review_skipped_no_license:org:author';
        const DAY = 86_400_000;

        beforeEach(() => {
            jest.useFakeTimers({ now: new Date('2026-11-28T12:00:00Z') });
        });
        afterEach(() => {
            jest.useRealTimers();
        });

        // Keyv drops an expired entry only when that key is read again, so
        // short-lived keys nobody reads again used to fill the entry cap and
        // push the live flag out.
        it('drops expired entries before a live one', async () => {
            const store = new BoundedMemoryStore(bounds);
            const cache = createCache({ stores: [new Keyv({ store })] });
            await cache.set(FLAG, true, DAY);

            // One short-lived key every 50 ms: about 20 are live at a time,
            // hundreds have expired by the end.
            for (let i = 0; i < 3 * bounds.maxEntries; i++) {
                await cache.set(`cli:trial:ratelimit:${i}`, 1, 1_000);
                jest.advanceTimersByTime(50);
            }
            for (let i = 0; i < 10; i++) {
                await cache.set(`etag:${i}`, 'v', DAY);
            }

            expect(await cache.get(FLAG)).toBe(true);
            expect(store.size).toBeLessThanOrEqual(bounds.maxEntries);
        });

        // File contents are cached for a day and are usually above
        // SMALL_ENTRY_BYTES: with room left in bytes, they reached the entry
        // cap first and took the flag with them.
        it('gives up a large value before a small one at the entry cap', async () => {
            const store = new BoundedMemoryStore({
                ...bounds,
                maxBytes: 10_000_000,
            });
            const cache = createCache({ stores: [new Keyv({ store })] });
            await cache.set(FLAG, true, DAY);

            for (let i = 0; i < 3 * bounds.maxEntries; i++) {
                await cache.set(`gh:contents:${i}`, 'x'.repeat(2_000), DAY);
            }

            expect(await cache.get(FLAG)).toBe(true);
            expect(store.size).toBe(bounds.maxEntries);
            // The value just written is served; the oldest file is not.
            expect(
                await cache.get(`gh:contents:${3 * bounds.maxEntries - 1}`),
            ).toBe('x'.repeat(2_000));
            expect(await cache.get('gh:contents:0')).toBeUndefined();
        });

        it('keeps dropping entries as they expire, sweep after sweep', () => {
            const store = new BoundedMemoryStore({ ...bounds, maxEntries: 3 });
            store.set('live', 'v', DAY);
            store.set('first', 'v', 1_000);
            store.set('second', 'v', 5_000);
            jest.advanceTimersByTime(2_000);
            store.set('a', 'v', DAY);
            expect([...store.keys()]).toEqual(['live', 'second', 'a']);

            store.delete('a');
            jest.advanceTimersByTime(4_000);
            store.set('b', 'v', DAY);
            store.set('c', 'v', DAY);
            // `second` expired after the first sweep: the second sweep drops
            // it, and the live entries all stay.
            expect([...store.keys()]).toEqual(['live', 'b', 'c']);
        });

        // Keyv serves an entry until `now > expires`.
        it('still holds an entry at its expiry millisecond', () => {
            const store = new BoundedMemoryStore({ ...bounds, maxEntries: 2 });
            store.set('older', 'v');
            store.set('flag', 'v', 1_000);
            jest.advanceTimersByTime(1_000);
            store.set('new', 'v');
            // Nothing has expired yet: the cap takes the oldest entry.
            expect([...store.keys()]).toEqual(['flag', 'new']);

            jest.advanceTimersByTime(1);
            store.set('newer', 'v');
            // One millisecond later the flag has expired and goes first.
            expect([...store.keys()]).toEqual(['new', 'newer']);
        });

        it('never expires an entry set without a TTL', () => {
            const store = new BoundedMemoryStore({ ...bounds, maxEntries: 3 });
            store.set('no-ttl', 'v');
            store.set('zero-ttl', 'v', 0);
            store.set('short', 'v', 1_000);
            jest.advanceTimersByTime(DAY);
            store.set('next', 'v', 1_000);

            // Over the cap by one: the expired entry goes, not the others.
            expect([...store.keys()]).toEqual(['no-ttl', 'zero-ttl', 'next']);
        });

        it('still serves a live entry whose TTL has not passed', async () => {
            const store = new BoundedMemoryStore({ ...bounds, maxEntries: 2 });
            const cache = createCache({ stores: [new Keyv({ store })] });
            await cache.set('a', 'v', 10_000);
            await cache.set('b', 'v', 1_000);
            jest.advanceTimersByTime(5_000);
            await cache.set('c', 'v', 10_000);

            // `b` had expired: it goes, and `a` stays although it is older.
            expect(await cache.get('a')).toBe('v');
            expect(await cache.get('c')).toBe('v');
            expect(store.has('b')).toBe(false);
        });
    });

    it('evicts by size from the values of at least SMALL_ENTRY_BYTES', () => {
        const store = new BoundedMemoryStore({
            ...bounds,
            maxBytes: 3 * SMALL_ENTRY_BYTES,
        });
        store.set('flag', 'x'.repeat(SMALL_ENTRY_BYTES - 1));
        store.set('big-1', 'x'.repeat(SMALL_ENTRY_BYTES));
        store.set('big-2', 'x'.repeat(SMALL_ENTRY_BYTES));
        store.set('big-3', 'x'.repeat(SMALL_ENTRY_BYTES));

        expect([...store.keys()]).toEqual(['flag', 'big-2', 'big-3']);
        expect(store.heldBytes).toBe(3 * SMALL_ENTRY_BYTES - 1);
    });

    it('still evicts small values by the entry cap', () => {
        const store = new BoundedMemoryStore({ ...bounds, maxEntries: 2 });
        store.set('flag', 'v');
        store.set('a', 'v');
        store.set('b', 'v');

        expect([...store.keys()]).toEqual(['a', 'b']);
    });

    it('holds maxBytes even when small values alone pass it', () => {
        const store = new BoundedMemoryStore({ ...bounds, maxBytes: 2_000 });
        for (let i = 0; i < 5; i++) store.set(`flag-${i}`, 'x'.repeat(900));

        expect([...store.keys()]).toEqual(['flag-3', 'flag-4']);
        expect(store.heldBytes).toBe(1_800);
    });

    it('evicts the large value nobody read, not the one just read', () => {
        const store = new BoundedMemoryStore({
            ...bounds,
            maxBytes: 2 * SMALL_ENTRY_BYTES,
        });
        store.set('big-1', 'x'.repeat(SMALL_ENTRY_BYTES));
        store.set('big-2', 'x'.repeat(SMALL_ENTRY_BYTES));
        store.get('big-1');
        store.set('big-3', 'x'.repeat(SMALL_ENTRY_BYTES));

        expect([...store.keys()].sort()).toEqual(['big-1', 'big-3']);
    });

    it('forgets a large key once it is replaced by a small value', () => {
        const store = new BoundedMemoryStore({
            ...bounds,
            maxBytes: 2 * SMALL_ENTRY_BYTES,
        });
        store.set('k', 'x'.repeat(SMALL_ENTRY_BYTES));
        store.set('k', 'v');
        store.set('big-1', 'x'.repeat(SMALL_ENTRY_BYTES));
        store.set('big-2', 'x'.repeat(SMALL_ENTRY_BYTES));

        // Over budget by one character: a large value goes, not the small `k`.
        expect([...store.keys()]).toEqual(['k', 'big-2']);
    });
});

describe('sizeOf', () => {
    // V8 keeps a Latin-1 string at one byte per character; one character
    // outside Latin-1 makes the whole string two bytes per character.
    it('counts a Latin-1 string at one byte per character', () => {
        expect(sizeOf('const a = 1; // café')).toBe(20);
    });

    it('counts a string with any character outside Latin-1 at two', () => {
        expect(sizeOf('const a = 1; // →')).toBe(34);
    });

    it('budgets a two-byte value at twice its characters', () => {
        const store = new BoundedMemoryStore({
            maxEntries: 10,
            maxBytes: 4_500,
            maxEntryBytes: 4_500,
        });
        store.set('ascii', 'x'.repeat(1_500));
        store.set('arrows', '→'.repeat(1_500));
        expect(store.heldBytes).toBe(4_500);
        store.set('more', 'x'.repeat(1_500));
        expect(store.has('ascii')).toBe(false);
        expect(store.has('arrows')).toBe(true);
        expect(store.heldBytes).toBe(4_500);
    });

    it('counts a character outside the Basic Multilingual Plane at two', () => {
        expect(sizeOf('ok 🙂')).toBe(10);
    });
});
