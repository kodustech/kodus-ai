import { IMemoryRepository } from '@/core/domain/automation/contracts/memory.repository';
import { Injectable } from '@nestjs/common';
import { MemoryModel } from './schema/memory.model';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MemoryEntity } from '@/core/domain/automation/entities/memory.entity';
import { IMemory } from '@/core/domain/automation/interfaces/memory.interface';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { transformId } from '@/shared/utils/mongo-utils';

@Injectable()
export class MemoryDatabaseRepository implements IMemoryRepository {
    constructor(
        @InjectModel(MemoryModel.name)
        private readonly memoryModel: Model<MemoryModel>,
    ) {}

    getNativeCollection() {
        try {
            const nativeConnection = this.memoryModel.db.collection('memory');

            return nativeConnection;
        } catch (error) {
            console.log(error);
        }
    }

    async create(memory: IMemory): Promise<MemoryEntity> {
        try {
            const memorySaved = await this.memoryModel.create(memory);

            return mapSimpleModelToEntity(memorySaved, MemoryEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<IMemory>,
        data: Partial<IMemory>,
    ): Promise<MemoryEntity> {
        try {
            const memory = await this.memoryModel.findOne(filter).lean().exec();

            await this.memoryModel
                .updateOne(filter, {
                    ...memory,
                    ...data,
                })
                .exec();

            return this.findById(memory._id.toString());
        } catch (error) {
            console.log(error);
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.memoryModel.deleteOne({ _id: transformId(uuid) }).exec();
        } catch (error) {
            console.error('Error deleting memory:', error);
            throw error;
        }
    }

    async findById(uuid: string): Promise<MemoryEntity> {
        try {
            const memory = await this.memoryModel
                .findOne({ _id: transformId(uuid) })
                .exec();

            return mapSimpleModelToEntity(memory, MemoryEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async findBySessionId(sessionId: string): Promise<MemoryEntity> {
        try {
            const memory = await this.memoryModel
                .findOne({ sessionId: sessionId })
                .exec();

            return mapSimpleModelToEntity(memory, MemoryEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async find(filter?: Partial<IMemory>): Promise<MemoryEntity[]> {
        try {
            const memories = await this.memoryModel
                .find(
                    {
                        ...filter,
                    },
                    null,
                    { skip: 1 },
                )
                .exec();

            return mapSimpleModelsToEntities(memories, MemoryEntity);
        } catch (error) {
            console.log(error);
        }
    }
}
