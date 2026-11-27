import { createCache } from 'cache-manager';
import { Keyv } from 'keyv';

import { BoundedMemoryStore, SMALL_ENTRY_CHARS } from './bounded-memory-store';

/**
 * The global cache must stay bounded whatever keys it gets: the GitHub client
 * caches file contents under blob-sha keys that are almost never read again.
 */
describe('BoundedMemoryStore', () => {
    const bounds = { maxEntries: 100, maxChars: 50_000, maxEntryChars: 20_000 };

    it('keeps the cache bounded under keys that are never read again', async () => {
        const store = new BoundedMemoryStore(bounds);
        const cache = createCache({ stores: [new Keyv({ store })] });
        const file = 'x'.repeat(4_000);

        // A day of reviews: every commit brings new blob shas.
        for (let i = 0; i < 2_000; i++) {
            await cache.set(`gh:contents:org/repo:${i}:src/a.ts`, file, 86_400_000);
        }

        expect(store.size).toBeLessThanOrEqual(bounds.maxEntries);
        expect(store.heldChars).toBeLessThanOrEqual(bounds.maxChars);
        // The newest entry is still served.
        expect(await cache.get('gh:contents:org/repo:1999:src/a.ts')).toBe(file);
        // The oldest was evicted.
        expect(await cache.get('gh:contents:org/repo:0:src/a.ts')).toBeUndefined();
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
        store.set('huge', 'x'.repeat(bounds.maxEntryChars + 1));
        expect(store.has('huge')).toBe(false);
        expect(store.has('small')).toBe(true);
    });

    it('re-setting a key replaces its size instead of adding to it', () => {
        const store = new BoundedMemoryStore(bounds);
        store.set('a', 'x'.repeat(1_000));
        store.set('a', 'x'.repeat(10));
        expect(store.heldChars).toBe(10);
        store.delete('a');
        expect(store.heldChars).toBe(0);
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
        expect(store.heldChars).toBe(100);
    });

    // validate-prerequisites dedupes the "review skipped (no license)" notice
    // at one per author per day through this cache. Evicted along with the
    // file contents, the author got it again every few hours.
    it('keeps a small flag for its TTL while large values pour through', async () => {
        const store = new BoundedMemoryStore(bounds);
        const cache = createCache({ stores: [new Keyv({ store })] });
        await cache.set('notif-rate:review_skipped_no_license:org:author', true, 86_400_000);

        for (let i = 0; i < 2_000; i++) {
            await cache.set(`gh:contents:${i}`, 'x'.repeat(4_000), 86_400_000);
        }

        expect(await cache.get('notif-rate:review_skipped_no_license:org:author')).toBe(true);
        expect(store.heldChars).toBeLessThanOrEqual(bounds.maxChars);
        expect(await cache.get('gh:contents:0')).toBeUndefined();
    });

    it('evicts by size from the values of at least SMALL_ENTRY_CHARS', () => {
        const store = new BoundedMemoryStore({ ...bounds, maxChars: 3 * SMALL_ENTRY_CHARS });
        store.set('flag', 'x'.repeat(SMALL_ENTRY_CHARS - 1));
        store.set('big-1', 'x'.repeat(SMALL_ENTRY_CHARS));
        store.set('big-2', 'x'.repeat(SMALL_ENTRY_CHARS));
        store.set('big-3', 'x'.repeat(SMALL_ENTRY_CHARS));

        expect([...store.keys()]).toEqual(['flag', 'big-2', 'big-3']);
        expect(store.heldChars).toBe(3 * SMALL_ENTRY_CHARS - 1);
    });

    it('still evicts small values by the entry cap', () => {
        const store = new BoundedMemoryStore({ ...bounds, maxEntries: 2 });
        store.set('flag', 'v');
        store.set('a', 'v');
        store.set('b', 'v');

        expect([...store.keys()]).toEqual(['a', 'b']);
    });
});
