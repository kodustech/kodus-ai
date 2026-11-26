import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Test } from '@nestjs/testing';
import type { Cache } from 'cache-manager';

import { GLOBAL_CACHE_BOUNDS, GlobalCacheModule } from './cache.module';

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

    it('is bounded at 50,000 entries, 256M characters, 8M per entry', () => {
        expect(GLOBAL_CACHE_BOUNDS).toEqual({
            maxEntries: 50_000,
            maxChars: 268_435_456,
            maxEntryChars: 8_388_608,
        });
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
