import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { ILogRepository } from '@/core/domain/log/contracts/log.repository.contracts';
import { LogModel } from './schema/log.model';
import { LogEntity } from '@/core/domain/log/entities/log.entity';
import { ILog } from '@/core/domain/log/interfaces/log.interface';

@Injectable()
export class LogDatabaseRepository implements ILogRepository {
    constructor(
        @InjectModel(LogModel.name)
        private readonly logModel: Model<LogModel>,
    ) {}

    async findOne(filter?: Partial<ILog>): Promise<LogEntity> {
        try {
            const log = await this.logModel.findOne(filter).exec();

            return mapSimpleModelToEntity(log, LogEntity);
        } catch (error) {
            console.log(error);
        }
    }

    getNativeCollection() {
        try {
            const nativeConnection = this.logModel.db.collection('log');

            return nativeConnection;
        } catch (error) {
            console.log(error);
        }
    }

    async create(log: ILog): Promise<void> {
        try {
            await this.logModel.create(log);
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<ILog>,
        data: Partial<ILog>,
    ): Promise<LogEntity> {
        try {
            const log = await this.logModel.findOne(filter).lean().exec();

            await this.logModel
                .updateOne(filter, {
                    ...log,
                    ...data,
                })
                .exec();

            return this.findById(log._id.toString());
        } catch (error) {
            console.log(error);
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.logModel.deleteOne({ _id: uuid }).exec();
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<LogEntity> {
        try {
            const log = await this.logModel.findOne({ _id: uuid });

            if (!log) {
                throw new Error('Log not found');
            }

            return mapSimpleModelToEntity(log, LogEntity);
        } catch (error) {
            console.error('Error in findById:', error);
            throw error;
        }
    }

    async find(filter?: Partial<ILog>): Promise<LogEntity[]> {
        try {
            const logs = await this.logModel
                .find(
                    {
                        ...filter,
                    },
                    null,
                    { skip: 1 },
                )
                .exec();

            return mapSimpleModelsToEntities(logs, LogEntity);
        } catch (error) {
            console.log(error);
        }
    }
}
