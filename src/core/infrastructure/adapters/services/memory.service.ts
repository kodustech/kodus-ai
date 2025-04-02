import {
    IMemoryRepository,
    MEMORY_REPOSITORY_TOKEN,
} from '@/core/domain/automation/contracts/memory.repository';
import { IMemoryService } from '@/core/domain/automation/contracts/memory.service';
import { MemoryEntity } from '@/core/domain/automation/entities/memory.entity';
import { IMemory } from '@/core/domain/automation/interfaces/memory.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class MemoryService implements IMemoryService {
    constructor(
        @Inject(MEMORY_REPOSITORY_TOKEN)
        private readonly memoryRepository: IMemoryRepository,
    ) {}

    findBySessionId(sessionId: string): Promise<MemoryEntity> {
        return this.memoryRepository.findBySessionId(sessionId);
    }

    getNativeCollection() {
        return this.memoryRepository.getNativeCollection();
    }

    create(memory: IMemory): Promise<MemoryEntity> {
        return this.memoryRepository.create(memory);
    }

    update(
        filter: Partial<IMemory>,
        data: Partial<IMemory>,
    ): Promise<MemoryEntity> {
        return this.memoryRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.memoryRepository.delete(uuid);
    }

    findById(uuid: string): Promise<MemoryEntity> {
        return this.memoryRepository.findById(uuid);
    }

    find(filter?: Partial<IMemory>): Promise<MemoryEntity[]> {
        return this.memoryRepository.find(filter);
    }
}
