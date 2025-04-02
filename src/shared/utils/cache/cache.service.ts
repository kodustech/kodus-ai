import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { Cache } from 'cache-manager';

@Injectable()
export class CacheService {
    constructor(
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private logger: PinoLoggerService,
    ) {}

    async addToCache<T>(
        key: string,
        item: T,
        ttl: number = 60000, // 1 minute
    ): Promise<void> {
        try {
            await this.cacheManager.set(key, JSON.stringify(item), ttl);
        } catch (error) {
            this.logger.error({
                message: 'Error adding item to cache with the key',
                context: CacheService.name,
                serviceName: 'CacheService',
                error: error,
                metadata: {
                    key: key,
                },
            });
        }
    }

    async getFromCache<T>(key: string): Promise<T | null> {
        try {
            const value = await this.cacheManager.get<string>(key);

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
                    key: key,
                },
            });
        }
    }

    async removeFromCache(key: string) {
        try {
            await this.cacheManager.del(key);
        } catch (error) {
            this.logger.error({
                message: 'Error removing item from cache with the key',
                context: CacheService.name,
                serviceName: 'CacheService',
                error: error,
                metadata: {
                    key: key,
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

    async cacheExists(key: string): Promise<boolean> {
        try {
            const value = await this.cacheManager.get(key);

            return value !== null;
        } catch (error) {
            this.logger.error({
                message:
                    'Error checking the existence of the item in the cache with the key',
                context: CacheService.name,
                serviceName: 'CacheService',
                error: error,
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
}
