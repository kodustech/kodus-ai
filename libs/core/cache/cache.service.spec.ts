import { createCache } from 'cache-manager';

import { cacheFootprint } from './cache.service';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('cacheFootprint', () => {
    it('counts the entries and value size of the store GlobalCacheModule builds', async () => {
        // The same call @nestjs/cache-manager makes for
        // CacheModule.register({ store: 'memory', max }): no `stores`.
        const cache = createCache({ ttl: 60_000 });
        await cache.set('a', 'x'.repeat(1024 * 1024));
        await cache.set('b', 'y');

        expect(cacheFootprint(cache)).toEqual({
            entries: 2,
            expired: 0,
            valueMb: 1,
        });
    });

    it('counts expired entries the store still holds until they are read', async () => {
        const cache = createCache({ ttl: 60_000 });
        await cache.set('old', 'v', 1);
        await wait(10);

        expect(cacheFootprint(cache)).toEqual({
            entries: 1,
            expired: 1,
            valueMb: 0,
        });
        await cache.get('old');
        expect(cacheFootprint(cache)).toEqual({
            entries: 0,
            expired: 0,
            valueMb: 0,
        });
    });

    it('reports an unknown store instead of guessing', () => {
        expect(cacheFootprint({ stores: [] } as any)).toEqual({ entries: -1 });
    });
});
