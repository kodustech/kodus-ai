import { CacheService } from '@/shared/utils/cache/cache.service';
import { CacheModule } from '@nestjs/cache-manager';
import { Global, Module } from '@nestjs/common';

@Global()
@Module({
    imports: [
        CacheModule.register({
            store: 'memory',
            max: 50000,
            isGlobal: true,
        }),
    ],
    providers: [CacheService],
    exports: [CacheService, CacheModule],
})
export class GlobalCacheModule {}
