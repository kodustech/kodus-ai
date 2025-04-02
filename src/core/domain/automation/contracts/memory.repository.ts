import { MemoryEntity } from '../entities/memory.entity';
import { IMemory } from '../interfaces/memory.interface';

export const MEMORY_REPOSITORY_TOKEN = Symbol('MemoryRepository');

export interface IMemoryRepository {
    create(memory: IMemory): Promise<MemoryEntity>;
    update(
        filter: Partial<IMemory>,
        data: Partial<IMemory>,
    ): Promise<MemoryEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findById(uuid: string): Promise<MemoryEntity | null>;
    findBySessionId(sessionId: string): Promise<MemoryEntity>;
    find(filter?: Partial<IMemory>): Promise<MemoryEntity[]>;
    getNativeCollection(): any;
}
