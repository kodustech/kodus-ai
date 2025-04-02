import { Module } from '@nestjs/common';
import { MemoryService } from '@/core/infrastructure/adapters/services/memory.service';
import { MongooseModule } from '@nestjs/mongoose';
import { MEMORY_SERVICE_TOKEN } from '@/core/domain/automation/contracts/memory.service';
import { MemoryDatabaseRepository } from '@/core/infrastructure/adapters/repositories/mongoose/memory.repository';
import { MEMORY_REPOSITORY_TOKEN } from '@/core/domain/automation/contracts/memory.repository';
import { MemoryModelInstance } from '@/core/infrastructure/adapters/repositories/mongoose/schema';

@Module({
    imports: [MongooseModule.forFeature([MemoryModelInstance])],
    providers: [
        {
            provide: MEMORY_SERVICE_TOKEN,
            useClass: MemoryService,
        },
        {
            provide: MEMORY_REPOSITORY_TOKEN,
            useClass: MemoryDatabaseRepository,
        },
    ],
    exports: [MEMORY_SERVICE_TOKEN, MEMORY_REPOSITORY_TOKEN],
})
export class MemoryModule {}
