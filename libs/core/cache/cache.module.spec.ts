import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Test } from '@nestjs/testing';
import type { Cache } from 'cache-manager';

import { BoundedMemoryStore } from './bounded-memory-store';
import {
    GLOBAL_CACHE_BOUNDS,
    GlobalCacheModule,
    globalCacheMaxChars,
} from './cache.module';

/**
 * The global cache grew without bound in production (Nov 2026): the options
 * it was registered with were ignored. These read the module as the app gets
 * it, not the store alone.
 */
describe('GlobalCacheModule', () => {
    let cache: Cache;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [GlobalCacheModule],
        }).compile();
        cache = moduleRef.get<Cache>(CACHE_MANAGER);
    });

    it('is bounded at 200,000 entries and 8M characters per entry', () => {
        expect(GLOBAL_CACHE_BOUNDS.maxEntries).toBe(200_000);
        expect(GLOBAL_CACHE_BOUNDS.maxEntryChars).toBe(8_388_608);
        expect(GLOBAL_CACHE_BOUNDS.maxChars).toBe(globalCacheMaxChars());
    });

    describe('character budget', () => {
        const GB = 1024 ** 3;

        // Production review workers run with an 8 GB heap.
        it('holds 2 GB of values (1G characters) on an 8 GB heap', () => {
            expect(globalCacheMaxChars(8 * GB)).toBe(1_073_741_824);
        });

        // A self-hosted worker on Node's default heap: 2 GB of cache would
        // take all of it.
        it('holds a quarter of a smaller heap', () => {
            expect(globalCacheMaxChars(2 * GB)).toBe(268_435_456);
            expect(globalCacheMaxChars(1 * GB)).toBe(134_217_728);
        });

        it('never holds more than 2 GB however large the heap', () => {
            expect(globalCacheMaxChars(64 * GB)).toBe(1_073_741_824);
        });
    });

    // The options the module was registered with before were ignored, and the
    // app ran on an unbounded Map. Read what the app's cache really holds.
    it('stores through a BoundedMemoryStore with those bounds', () => {
        const store = (cache as any).stores[0].store;
        expect(store).toBeInstanceOf(BoundedMemoryStore);
        expect(store.bounds).toEqual(GLOBAL_CACHE_BOUNDS);
    });

    it('stops growing at the entry bound when set through the cache', async () => {
        const store: BoundedMemoryStore = (cache as any).stores[0].store;
        for (let i = 0; i <= GLOBAL_CACHE_BOUNDS.maxEntries; i++) {
            await cache.set(`k:count:${i}`, 'v', 60_000);
        }
        expect(store.size).toBe(GLOBAL_CACHE_BOUNDS.maxEntries);
        expect(await cache.get('k:count:0')).toBeUndefined();
        expect(
            await cache.get(`k:count:${GLOBAL_CACHE_BOUNDS.maxEntries}`),
        ).toBe('v');
    });

    it('caches an ordinary value', async () => {
        await cache.set('k:small', 'x'.repeat(1_000), 60_000);
        expect(await cache.get('k:small')).toBe('x'.repeat(1_000));
    });

    it('does not cache a value larger than the per-entry bound', async () => {
        await cache.set('k:huge', 'x'.repeat(8_388_608), 60_000);
        expect(await cache.get('k:huge')).toBeUndefined();
    });
});
