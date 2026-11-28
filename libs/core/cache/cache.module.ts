import { CacheModule } from '@nestjs/cache-manager';
import { Global, Module } from '@nestjs/common';
import { Keyv } from 'keyv';
import { getHeapStatistics } from 'v8';

import { BoundedMemoryStore } from './bounded-memory-store';
import { CacheService } from './cache.service';

/** What the process-wide cache may hold where the heap allows it. */
export const GLOBAL_CACHE_TARGET_BYTES = 2 * 1024 ** 3;

/**
 * The byte budget of the process-wide cache: 2 GB of values, and never more
 * than a quarter of this process's heap. Production review workers run with
 * an 8 GB heap and get the full 2 GB; a self-hosted worker on Node's default
 * (~2 GB) gets 512 MB, so the cache cannot take its whole heap. Sizes are the
 * bytes V8 really holds (bounded-memory-store.ts `sizeOf`), not characters.
 */
export function globalCacheMaxBytes(
    heapLimitBytes: number = getHeapStatistics().heap_size_limit,
): number {
    return Math.floor(Math.min(GLOBAL_CACHE_TARGET_BYTES, heapLimitBytes / 4));
}

/**
 * Bounds of the process-wide cache. `store`/`max` are not read by
 * @nestjs/cache-manager 3 (see bounded-memory-store.ts), so the bounds live in
 * the store itself. The entry cap leaves room for the size budget: file
 * contents average tens of KB, so 50k entries would stop the cache near 1 GB.
 * No single value above 8 MB is cached.
 */
export const GLOBAL_CACHE_BOUNDS = {
    maxEntries: 200_000,
    maxBytes: globalCacheMaxBytes(),
    maxEntryBytes: 8 * 1024 * 1024,
};

@Global()
@Module({
    imports: [
        CacheModule.register({
            stores: [
                new Keyv({
                    store: new BoundedMemoryStore(GLOBAL_CACHE_BOUNDS),
                }),
            ],
            isGlobal: true,
        }),
    ],
    providers: [CacheService],
    exports: [CacheService, CacheModule],
})
export class GlobalCacheModule {}
