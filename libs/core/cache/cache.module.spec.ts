import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Test } from '@nestjs/testing';
import type { Cache } from 'cache-manager';

import { BoundedMemoryStore } from './bounded-memory-store';
import {
    GLOBAL_CACHE_BOUNDS,
    GlobalCacheModule,
    globalCacheMaxBytes,
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

    it('is bounded at 200,000 entries and 8 MB per entry', () => {
        expect(GLOBAL_CACHE_BOUNDS.maxEntries).toBe(200_000);
        expect(GLOBAL_CACHE_BOUNDS.maxEntryBytes).toBe(8_388_608);
        expect(GLOBAL_CACHE_BOUNDS.maxBytes).toBe(globalCacheMaxBytes());
    });

    describe('byte budget', () => {
        const GB = 1024 ** 3;

        // Production review workers run with an 8 GB heap.
        it('holds 2 GB of values on an 8 GB heap', () => {
            expect(globalCacheMaxBytes(8 * GB)).toBe(2 * GB);
        });

        // A self-hosted worker on Node's default heap: 2 GB of cache would
        // take all of it.
        it('holds a quarter of a smaller heap', () => {
            expect(globalCacheMaxBytes(2 * GB)).toBe(GB / 2);
            expect(globalCacheMaxBytes(1 * GB)).toBe(GB / 4);
        });

        it('never holds more than 2 GB however large the heap', () => {
            expect(globalCacheMaxBytes(64 * GB)).toBe(2 * GB);
        });
    });

    // The options the module was registered with before were ignored, and the
    // app ran on an unbounded Map. Read what the app's cache really holds.
    it('stores through a BoundedMemoryStore with those bounds', () => {
        const store = (cache as any).stores[0].store;
        expect(store).toBeInstanceOf(BoundedMemoryStore);
        expect(store.bounds).toEqual(GLOBAL_CACHE_BOUNDS);
    });

    // This loop takes 300-500 s on the CI runner. With a 60 s TTL the store
    // rightly swept the expired keys midway and held 42,243: the TTL must
    // outlive the run, or this measures the clock instead of the bound.
    it('stops growing at the entry bound when set through the cache', async () => {
        const store: BoundedMemoryStore = (cache as any).stores[0].store;
        const outlivesTheRun = 24 * 60 * 60_000;
        for (let i = 0; i <= GLOBAL_CACHE_BOUNDS.maxEntries; i++) {
            await cache.set(`k:count:${i}`, 'v', outlivesTheRun);
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
