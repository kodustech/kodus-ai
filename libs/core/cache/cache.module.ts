import { CacheModule } from '@nestjs/cache-manager';
import { Global, Module } from '@nestjs/common';
import { Keyv } from 'keyv';

import { BoundedMemoryStore } from './bounded-memory-store';
import { CacheService } from './cache.service';

/**
 * Bounds of the process-wide cache. `store`/`max` are not read by
 * @nestjs/cache-manager 3 (see bounded-memory-store.ts), so the bounds live in
 * the store itself: 256M characters is ~512 MB of UTF-16, a fraction of the
 * worker's 8 GB heap, and no single value above 8M characters is cached.
 */
export const GLOBAL_CACHE_BOUNDS = {
    maxEntries: 50_000,
    maxChars: 256 * 1024 * 1024,
    maxEntryChars: 8 * 1024 * 1024,
};

@Global()
@Module({
    imports: [
        CacheModule.register({
            stores: [
                new Keyv({ store: new BoundedMemoryStore(GLOBAL_CACHE_BOUNDS) }),
            ],
            isGlobal: true,
        }),
    ],
    providers: [CacheService],
    exports: [CacheService, CacheModule],
})
export class GlobalCacheModule {}
