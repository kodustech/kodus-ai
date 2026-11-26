import { createCache } from 'cache-manager';
import { Keyv } from 'keyv';

import { BoundedMemoryStore } from './bounded-memory-store';

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
});
