import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { TeamArtifactsModel } from './schema/teamArtifact.model';
import { ITeamArtifactsRepository } from '@/core/domain/teamArtifacts/contracts/teamArtifacts.repository';
import { ITeamArtifacts } from '@/core/domain/teamArtifacts/interfaces/teamArtifacts.interface';
import { TeamArtifactsEntity } from '@/core/domain/teamArtifacts/entities/teamArtifacts.entity';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

@Injectable()
export class TeamArtifactsDatabaseRepository
    implements ITeamArtifactsRepository
{
    constructor(
        @InjectModel(TeamArtifactsModel.name)
        private readonly teamArtifactsModel: Model<TeamArtifactsModel>,
    ) {}

    async findOne(
        filter?: Partial<ITeamArtifacts>,
    ): Promise<TeamArtifactsEntity> {
        try {
            const teamArtifact = await this.teamArtifactsModel
                .findOne(filter)
                .exec();

            return mapSimpleModelToEntity(teamArtifact, TeamArtifactsEntity);
        } catch (error) {
            console.log(error);
        }
    }

    getNativeCollection() {
        try {
            const nativeConnection =
                this.teamArtifactsModel.db.collection('teamArtifact');

            return nativeConnection;
        } catch (error) {
            console.log(error);
        }
    }

    async create(teamArtifact: ITeamArtifacts): Promise<TeamArtifactsEntity> {
        try {
            const agentExecutionSaved =
                await this.teamArtifactsModel.create(teamArtifact);

            return mapSimpleModelToEntity(
                agentExecutionSaved,
                TeamArtifactsEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<ITeamArtifacts>,
        data: Partial<ITeamArtifacts>,
    ): Promise<TeamArtifactsEntity> {
        try {
            const teamArtifact = await this.teamArtifactsModel
                .findOne(filter)
                .lean()
                .exec();

            await this.teamArtifactsModel
                .updateOne(filter, {
                    ...teamArtifact,
                    ...data,
                })
                .exec();

            return this.findById(teamArtifact._id.toString());
        } catch (error) {
            console.log(error);
        }
    }

    async bulkUpdateOfEnrichedArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
        updatedData: {
            uuid: string;
            relatedData: any;
        }[],
    ): Promise<void> {
        try {
            const operations = updatedData.map((data) => ({
                updateOne: {
                    filter: {
                        _id: new Types.ObjectId(data.uuid),
                        organizationId: organizationAndTeamData.organizationId,
                        teamId: organizationAndTeamData.teamId,
                    },
                    update: {
                        $set: {
                            relatedData: data.relatedData,
                        },
                    },
                },
            }));

            await this.teamArtifactsModel.bulkWrite(operations, {
                ordered: false,
            });
        } catch (error) {
            console.log('Error during bulk update of team artifacts: ', error);
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            await this.teamArtifactsModel.deleteOne({ _id: uuid }).exec();
        } catch (error) {
            console.log(error);
        }
    }

    async findById(uuid: string): Promise<TeamArtifactsEntity> {
        try {
            const teamArtifact = await this.teamArtifactsModel.findOne({
                _id: uuid,
            });

            return mapSimpleModelToEntity(teamArtifact, TeamArtifactsEntity);
        } catch (error) {
            console.log(error);
        }
    }

    async find(
        filter?: Partial<ITeamArtifacts>,
    ): Promise<TeamArtifactsEntity[]> {
        try {
            const teamArtifacts = await this.teamArtifactsModel
                .find(
                    {
                        ...filter,
                    },
                    null,
                    { skip: 1 },
                )
                .exec();

            return mapSimpleModelsToEntities(
                teamArtifacts,
                TeamArtifactsEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async getMostRecentArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
        frequenceType?: string,
        resultType?: string,
    ): Promise<TeamArtifactsEntity[]> {
        try {
            const matchCondition: any = {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            };

            if (!!frequenceType) {
                matchCondition.frequenceType = frequenceType;
            }

            if (!!resultType) {
                matchCondition.resultType = resultType;
            }

            const teamArtifacts = await this.teamArtifactsModel
                .aggregate([
                    {
                        $match: matchCondition,
                    },

                    { $sort: { analysisFinalDate: -1 } },

                    {
                        $group: {
                            _id: '$name',
                            mostRecentDate: { $max: '$analysisFinalDate' },
                            doc: { $first: '$$ROOT' },
                        },
                    },

                    {
                        $replaceRoot: {
                            newRoot: '$doc',
                        },
                    },
                ])
                .exec();

            return mapSimpleModelsToEntities(
                teamArtifacts,
                TeamArtifactsEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async getPenultimateArtifacts(
        teamId: string,
        organizationId: string,
        frequenceType?: string,
    ): Promise<TeamArtifactsEntity[]> {
        try {
            const matchCondition: any = {
                organizationId: organizationId,
                teamId: teamId,
            };

            if (frequenceType !== undefined && frequenceType !== null) {
                matchCondition.frequenceType = frequenceType;
            }

            const teamArtifacts = await this.teamArtifactsModel
                .aggregate([
                    // Step 1: Filter by organizationId and teamId
                    {
                        $match: matchCondition,
                    },
                    // Step 2: Sort documents by analysisFinalDate in descending order
                    { $sort: { analysisFinalDate: -1 } },
                    // Step 3: Group documents by analysisFinalDate to identify unique dates, keeping grouped documents
                    {
                        $group: {
                            _id: '$analysisFinalDate',
                            docs: { $push: '$$ROOT' },
                        },
                    },
                    // Step 4: Sort grouped dates in descending order to ensure correct order
                    { $sort: { _id: -1 } },
                    // Step 5: Skip the most recent date and limit to the next one to get the penultimate
                    { $skip: 2 },
                    { $limit: 1 },
                    // Step 6: Ungroup documents from the penultimate date
                    { $unwind: '$docs' },
                    // Step 7: Replace the root document with the penultimate documents
                    { $replaceRoot: { newRoot: '$docs' } },
                ])
                .exec();

            return mapSimpleModelsToEntities(
                teamArtifacts,
                TeamArtifactsEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async getTeamArtifactsByWeeksLimit(
        organizationAndTeamData: OrganizationAndTeamData,
        weeksLimit: number,
        frequenceType?: string,
        resultType: string = 'Negative',
    ): Promise<TeamArtifactsEntity[]> {
        try {
            const currentDate = new Date();
            const weeksAgoDate = new Date();
            weeksAgoDate.setDate(currentDate.getDate() - weeksLimit * 7); // Calculates the date N weeks ago

            const filteredTeamId = organizationAndTeamData.teamId
                ? { teamId: organizationAndTeamData.teamId }
                : null;

            const matchCondition: any = {
                organizationId: organizationAndTeamData.organizationId,
                resultType: resultType,
                ...filteredTeamId,
            };

            if (frequenceType !== undefined && frequenceType !== null) {
                matchCondition.frequenceType = frequenceType;
            }

            const teamArtifacts = await this.teamArtifactsModel
                .aggregate([
                    // Step 1: Filter by organizationId, teamId, and analysisFinalDate within the N-week limit
                    {
                        $match: matchCondition,
                    },
                    // Step 2: Sort documents by analysisFinalDate in descending order
                    { $sort: { analysisFinalDate: -1 } },
                    // Step 3: Group documents by analysisFinalDate to form artifact groups
                    {
                        $group: {
                            _id: '$analysisFinalDate',
                            documents: { $push: '$$ROOT' },
                        },
                    },
                    // Step 4: Sort the groups of documents by analysisFinalDate in descending order
                    { $sort: { _id: -1 } },
                    // Step 5: Limit to the N most recent groups based on the weeksLimit parameter
                    { $limit: weeksLimit },
                    // Optional: Ungroup the documents if necessary to return a flat list of artifacts
                    { $unwind: '$documents' },
                    { $replaceRoot: { newRoot: '$documents' } },
                ])
                .exec();

            return mapSimpleModelsToEntities(
                teamArtifacts,
                TeamArtifactsEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async dismissArtifact(
        artifactId: string,
        userId: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        try {
            await this.teamArtifactsModel.updateOne(
                {
                    _id: artifactId,
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
                {
                    $push: {
                        dismiss: {
                            dismiss: true,
                            userId: userId,
                        },
                    },
                },
                { new: true, upsert: false },
            );
        } catch (error) {
            console.log(error);
        }
    }

    async getMostRecentArtifactVisible(
        organizationAndTeamData: OrganizationAndTeamData,
        frequenceType?: string,
        userId?: string,
        resultType: string = 'Negative', // Defined to search only for negative results
    ): Promise<TeamArtifactsEntity[]> {
        try {
            const matchCondition: any = {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                resultType: resultType, // Including the resultType filter here
            };

            if (frequenceType) {
                matchCondition.frequenceType = frequenceType;
            }

            const teamArtifacts = await this.teamArtifactsModel
                .aggregate([
                    // Step 1: Filter by organizationId, teamId, and resultType
                    {
                        $match: matchCondition,
                    },

                    // Step 2: Sort documents by analysisFinalDate in descending order
                    { $sort: { analysisFinalDate: -1 } },

                    // Step 3: Group by 'name' and find the most recent date for each 'name'
                    {
                        $group: {
                            _id: '$name',
                            mostRecentDate: { $max: '$analysisFinalDate' },
                            doc: { $first: '$$ROOT' }, // Keeps the most recent complete document
                        },
                    },

                    // Step 4: Expand the grouped documents
                    {
                        $replaceRoot: {
                            newRoot: '$doc',
                        },
                    },

                    // Step 5: Filter documents that have 'dismiss' empty, absent, or not significant
                    {
                        $match: {
                            $or: [
                                { dismiss: { $exists: false } },
                                { dismiss: { $size: 0 } },
                                { dismiss: null },
                            ],
                        },
                    },
                ])
                .exec();

            return mapSimpleModelsToEntities(
                teamArtifacts,
                TeamArtifactsEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }
}
