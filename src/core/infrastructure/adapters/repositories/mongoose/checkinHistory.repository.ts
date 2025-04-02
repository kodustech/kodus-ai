import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage } from 'mongoose';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { ICheckinHistoryRepository } from '@/core/domain/checkinHistory/contracts/checkinHistory.repository';
import { CheckinHistoryModel } from './schema/checkinHistory.model';
import { CheckinHistoryEntity } from '@/core/domain/checkinHistory/entities/checkinHistory.entity';
import { ICheckinHistory } from '@/core/domain/checkinHistory/interfaces/checkinHistory.interface';

@Injectable()
export class CheckinHistoryDatabaseRepository
    implements ICheckinHistoryRepository
{
    constructor(
        @InjectModel(CheckinHistoryModel.name)
        private readonly checkinHistoryModel: Model<CheckinHistoryModel>,
    ) {}

    async findOne(
        filter?: Partial<ICheckinHistory>,
    ): Promise<CheckinHistoryEntity> {
        try {
            const checkinHistory = await this.checkinHistoryModel
                .findOne(filter)
                .exec();

            return mapSimpleModelToEntity(checkinHistory, CheckinHistoryEntity);
        } catch (error) {
            console.log(error);
        }
    }

    getNativeCollection() {
        try {
            const nativeConnection =
                this.checkinHistoryModel.db.collection('checkinHistory');

            return nativeConnection;
        } catch (error) {
            console.log(error);
        }
    }

    async create(
        checkinHistory: ICheckinHistory,
    ): Promise<CheckinHistoryEntity> {
        try {
            const agentExecutionSaved =
                await this.checkinHistoryModel.create(checkinHistory);

            return mapSimpleModelToEntity(
                agentExecutionSaved,
                CheckinHistoryEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<ICheckinHistory>,
        data: Partial<ICheckinHistory>,
    ): Promise<CheckinHistoryEntity> {
        try {
            const checkinHistory = await this.checkinHistoryModel
                .findOne(filter)
                .lean()
                .exec();

            await this.checkinHistoryModel
                .updateOne(filter, {
                    ...checkinHistory,
                    ...data,
                })
                .exec();

            return this.findById(checkinHistory._id.toString());
        } catch (error) {
            console.log(error);
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.checkinHistoryModel.deleteOne({ _id: uuid }).exec();
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<CheckinHistoryEntity> {
        try {
            const checkinHistory = await this.checkinHistoryModel.findOne({
                _id: uuid,
            });

            if (!checkinHistory) {
                throw new Error('CheckinHistory not found');
            }

            return mapSimpleModelToEntity(checkinHistory, CheckinHistoryEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async find(
        filter?: Partial<ICheckinHistory>,
    ): Promise<CheckinHistoryEntity[]> {
        try {
            const checkinHistory = await this.checkinHistoryModel
                .find(
                    {
                        ...filter,
                    },
                    null,
                    { skip: 1 },
                )
                .exec();

            return mapSimpleModelsToEntities(
                checkinHistory,
                CheckinHistoryEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async getCheckinHistoryWithDayLimit(
        filter?: Partial<ICheckinHistory>,
        limit?: number,
    ): Promise<CheckinHistoryEntity[]> {
        try {
            const query: any = { ...filter };
            let checkinHistory: CheckinHistoryModel[] = [];

            if (limit) {
                checkinHistory = await this.checkinHistoryModel
                    .find(query)
                    .sort({ date: -1 })
                    .limit(limit)
                    .exec();
            }

            checkinHistory = await this.checkinHistoryModel.find(query).exec();

            return mapSimpleModelsToEntities(
                checkinHistory,
                CheckinHistoryEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async getLastCheckinForTeam(teamId: string): Promise<CheckinHistoryEntity> {
        try {
            const checkinHistory = await this.checkinHistoryModel
                .findOne({
                    teamId: teamId,
                })
                .sort({ data: -1 })
                .exec();

            return mapSimpleModelToEntity(checkinHistory, CheckinHistoryEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async getCheckinHistoryByDays(
        filter: Partial<ICheckinHistory>,
        days: number,
    ): Promise<CheckinHistoryEntity[]> {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const startDate = new Date(today);
        startDate.setDate(startDate.getDate() - days);

        const pipeline: PipelineStage[] = [
            {
                $match: {
                    ...filter,
                    date: { $gte: startDate, $lt: today },
                },
            },
            {
                $sort: { date: -1 } as const,
            },
            {
                $group: {
                    _id: {
                        $dateToString: { format: '%Y-%m-%d', date: '$date' },
                    },
                    doc: { $first: '$$ROOT' },
                },
            },
            {
                $replaceRoot: { newRoot: '$doc' },
            },
            {
                $sort: { date: -1 } as const,
            },
        ];

        const checkinHistory = await this.checkinHistoryModel
            .aggregate(pipeline)
            .exec();

        return checkinHistory.map((doc) => new CheckinHistoryEntity(doc));
    }
}
