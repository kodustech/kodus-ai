import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';

import { ICheckinHistoryOrganizationRepository } from '@/core/domain/checkinHistoryOrganization/contracts/checkinHistoryOrganization.repository';
import { ICheckinHistoryOrganization } from '@/core/domain/checkinHistoryOrganization/interfaces/checkinHistoryOrganization.interface';
import { CheckinHistoryOrganizationEntity } from '@/core/domain/checkinHistoryOrganization/entities/checkinHistoryOrganization.entity';
import { CheckinHistoryOrganizationModel } from './schema/checkinHistoryOrganization.model';

@Injectable()
export class CheckinHistoryOrganizationDatabaseRepository
    implements ICheckinHistoryOrganizationRepository {
    constructor(
        @InjectModel(CheckinHistoryOrganizationModel.name)
        private readonly checkinHistoryOrganizationModel: Model<CheckinHistoryOrganizationModel>,
    ) { }

    async findOne(
        filter?: Partial<ICheckinHistoryOrganization>,
    ): Promise<CheckinHistoryOrganizationEntity> {
        try {
            const checkinHistoryOrganization = await this.checkinHistoryOrganizationModel
                .findOne(filter)
                .exec();

            return mapSimpleModelToEntity(checkinHistoryOrganization, CheckinHistoryOrganizationEntity);
        } catch (error) {
            console.log(error);
        }
    }

    getNativeCollection() {
        try {
            const nativeConnection =
                this.checkinHistoryOrganizationModel.db.collection('checkinHistoryOrganization');

            return nativeConnection;
        } catch (error) {
            console.log(error);
        }
    }

    async create(
        checkinHistoryOrganization: ICheckinHistoryOrganization,
    ): Promise<CheckinHistoryOrganizationEntity> {
        try {
            const agentExecutionSaved =
                await this.checkinHistoryOrganizationModel.create(checkinHistoryOrganization);

            return mapSimpleModelToEntity(
                agentExecutionSaved,
                CheckinHistoryOrganizationEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<ICheckinHistoryOrganization>,
        data: Partial<ICheckinHistoryOrganization>,
    ): Promise<CheckinHistoryOrganizationEntity> {
        try {
            const checkinHistoryOrganization = await this.checkinHistoryOrganizationModel
                .findOne(filter)
                .lean()
                .exec();

            await this.checkinHistoryOrganizationModel
                .updateOne(filter, {
                    ...checkinHistoryOrganization,
                    ...data,
                })
                .exec();

            return this.findById(checkinHistoryOrganization._id.toString());
        } catch (error) {
            console.log(error);
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.checkinHistoryOrganizationModel.deleteOne({ _id: uuid }).exec();
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<CheckinHistoryOrganizationEntity> {
        try {
            const checkinHistoryOrganization = await this.checkinHistoryOrganizationModel.findOne({
                _id: uuid,
            });

            return mapSimpleModelToEntity(checkinHistoryOrganization, CheckinHistoryOrganizationEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async find(
        filter?: Partial<ICheckinHistoryOrganization>,
    ): Promise<CheckinHistoryOrganizationEntity[]> {
        try {
            const checkinHistoryOrganization = await this.checkinHistoryOrganizationModel
                .find(
                    {
                        ...filter,
                    },
                    null,
                    { skip: 1 },
                )
                .exec();

            return mapSimpleModelsToEntities(
                checkinHistoryOrganization,
                CheckinHistoryOrganizationEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async getCheckinHistoryWithDayLimit(
        filter?: Partial<ICheckinHistoryOrganization>,
        limit?: number,
    ): Promise<CheckinHistoryOrganizationEntity[]> {
        try {
            const query: any = { ...filter };
            let checkinHistoryOrganization: CheckinHistoryOrganizationModel[] = [];

            if (limit) {
                checkinHistoryOrganization = await this.checkinHistoryOrganizationModel
                    .find(query)
                    .sort({ date: -1 })
                    .limit(limit)
                    .exec();
            }

            checkinHistoryOrganization = await this.checkinHistoryOrganizationModel.find(query).exec();

            return mapSimpleModelsToEntities(
                checkinHistoryOrganization,
                CheckinHistoryOrganizationEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async getLastCheckinForTeam(teamId: string): Promise<CheckinHistoryOrganizationEntity> {
        try {
            const checkinHistoryOrganization = await this.checkinHistoryOrganizationModel
                .findOne({
                    teamsIds: teamId,
                })
                .sort({ data: -1 })
                .exec();

            return mapSimpleModelToEntity(checkinHistoryOrganization, CheckinHistoryOrganizationEntity);
        } catch (error) {
            console.log(error);
        }
    }
}
