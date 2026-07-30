import { createLogger } from '@libs/core/log/logger';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { Cache } from 'cache-manager';

@Injectable()
export class CacheService {
    private readonly logger = createLogger(CacheService.name);
    constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

    async addToCache<T>(
        key: string | number,
        item: T,
        ttl: number = 60000, // 1 minute
    ): Promise<void> {
        const keyStr = String(key);
        try {
            await this.cacheManager.set(keyStr, JSON.stringify(item), ttl);
        } catch (error) {
            this.logger.error({
                message: 'Error adding item to cache with the key',
                context: CacheService.name,
                serviceName: 'CacheService',
                error: error,
                metadata: {
                    key: keyStr,
                },
            });
        }
    }

    async getFromCache<T>(key: string | number): Promise<T | null> {
        const keyStr = String(key);
        try {
            const value = await this.cacheManager.get<string>(keyStr);

            if (!value) {
                return null;
            }

            return JSON.parse(value) as T;
        } catch (error) {
            this.logger.error({
                message: 'Error retrieving item from cache with the key',
                context: CacheService.name,
                serviceName: 'CacheService',
                error: error,
                metadata: {
                    key: keyStr,
                },
            });
        }
    }

    async removeFromCache(key: string | number) {
        const keyStr = String(key);
        try {
            await this.cacheManager.del(keyStr);
        } catch (error) {
            this.logger.error({
                message: 'Error removing item from cache with the key',
                context: CacheService.name,
                serviceName: 'CacheService',
                error: error,
                metadata: {
                    key: keyStr,
                },
            });
        }
    }

    async clearCache() {
        try {
            await this.cacheManager.clear();
        } catch (error) {
            this.logger.error({
                message: 'Error clearing the cache',
                context: CacheService.name,
                serviceName: 'CacheService',
                error: error,
            });
        }
    }

    async cacheExists(key: string | number): Promise<boolean> {
        const keyStr = String(key);
        try {
            const value = await this.cacheManager.get(keyStr);

            return !!value;
        } catch (error) {
            this.logger.error({
                message:
                    'Error checking the existence of the item in the cache with the key',
                context: CacheService.name,
                serviceName: 'CacheService',
                error: error,
                metadata: {
                    key: keyStr,
                },
            });
            return false;
        }
    }

    async getMultipleFromCache<T>(keys: string[]): Promise<(T | null)[]> {
        try {
            const values = await Promise.all(
                keys.map((key) => this.getFromCache<T>(key)),
            );

            return values;
        } catch (error) {
            this.logger.error({
                message: 'Error retrieving multiple items from the cache',
                context: CacheService.name,
                serviceName: 'CacheService',
                error: error,
            });
            return [];
        }
    }

    async deleteByKeyPattern(pattern: string): Promise<void> {
        try {
            this.logger.log({
                message:
                    'Invalidating cache for pull requests executions endpoint',
                context: CacheService.name,
                metadata: { pattern },
            });

            await this.cacheManager.clear();
        } catch (error) {
            this.logger.error({
                message: 'Error invalidating cache by pattern',
                context: CacheService.name,
                serviceName: 'CacheService',
                error: error,
                metadata: {
                    pattern: pattern,
                },
            });
        }
    }
}
