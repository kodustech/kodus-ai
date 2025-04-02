import { IOrganizationArtifactsRepository } from '@/core/domain/organizationArtifacts/contracts/organizationArtifactsArtifacts.repository';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OrganizationArtifactsModel } from './schema/organizationArtifact.model';
import { Model } from 'mongoose';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IOrganizationArtifacts } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifacts.interface';
import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@/shared/infrastructure/repositories/mappers';
import { OrganizationArtifactsEntity } from '@/core/domain/organizationArtifacts/entities/organizationArtifacts.entity';

@Injectable()
export class OrganizationArtifactsDatabaseRepository
    implements IOrganizationArtifactsRepository
{
    constructor(
        @InjectModel(OrganizationArtifactsModel.name)
        private readonly organizationArtifactsModel: Model<OrganizationArtifactsModel>,
    ) {}

    async getVisibleArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
        userId?: string,
    ): Promise<OrganizationArtifactsEntity[]> {
        try {
            const organizationArtifacts = await this.organizationArtifactsModel
                .aggregate([
                    {
                        $match: {
                            organizationId:
                                organizationAndTeamData.organizationId,
                        },
                    },
                    {
                        $addFields: {
                            createdAtLong: { $toLong: '$createdAt' },
                        },
                    },
                    {
                        $sort: { createdAtLong: -1 },
                    },
                    {
                        $group: {
                            _id: {
                                name: '$name',
                                teamId: {
                                    $arrayElemAt: ['$teamsArtifact.teamId', 0],
                                },
                            },
                            doc: { $first: '$$ROOT' },
                        },
                    },
                    {
                        $replaceRoot: { newRoot: '$doc' },
                    },
                    {
                        $unwind: '$teamsArtifact',
                    },
                    {
                        $match: {
                            ...(organizationAndTeamData.teamId && {
                                'teamsArtifact.teamId':
                                    organizationAndTeamData.teamId,
                            }),
                            'teamsArtifact.dismiss': {
                                $not: {
                                    $elemMatch: {
                                        userId: userId,
                                        dismiss: true,
                                    },
                                },
                            },
                        },
                    },
                    {
                        $group: {
                            _id: '$_id',
                            root: { $first: '$$ROOT' },
                            teamsArtifact: { $push: '$teamsArtifact' },
                        },
                    },
                    {
                        $replaceRoot: {
                            newRoot: {
                                $mergeObjects: [
                                    '$root',
                                    { teamsArtifact: '$teamsArtifact' },
                                ],
                            },
                        },
                    },
                    {
                        $project: {
                            '_id': 1,
                            'name': 1,
                            'createdAt': 1,
                            'updatedAt': 1,
                            'category': 1,
                            'organizationId': 1,
                            'teamsArtifact.name': 1,
                            'teamsArtifact.teamId': 1,
                            'teamsArtifact.teamName': 1,
                            'teamsArtifact.title': 1,
                            'teamsArtifact.description': 1,
                            'teamsArtifact.criticality': 1,
                            'teamsArtifact.additionalInfoFormated': 1,
                            'whyIsImportant': 1,
                        },
                    },
                    {
                        $sort: {
                            'teamsArtifact.criticality': -1,
                            'createdAtLong': -1,
                        },
                    },
                ])
                .exec();

            return mapSimpleModelsToEntities(
                organizationArtifacts,
                OrganizationArtifactsEntity,
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
            await this.organizationArtifactsModel.updateOne(
                {
                    '_id': artifactId,
                    'organizationId': organizationAndTeamData.organizationId,
                    'teamsArtifact.teamId': organizationAndTeamData.teamId,
                },
                {
                    $push: {
                        'teamsArtifact.$.dismiss': {
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

    async create(
        organizationArtifacts: Omit<IOrganizationArtifacts, 'uuid'>,
    ): Promise<OrganizationArtifactsEntity> {
        try {
            const filteredTeamArtifacts =
                organizationArtifacts.teamsArtifact?.filter(
                    (artifact) =>
                        artifact.resultType !== undefined &&
                        artifact.criticality !== undefined &&
                        !isNaN(artifact.criticality),
                );

            if (!filteredTeamArtifacts?.length) {
                return;
            }

            const artifactsToSave = {
                ...organizationArtifacts,
                teamsArtifact: filteredTeamArtifacts,
            };

            const organizationArtifactsExecutionSaved =
                await this.organizationArtifactsModel.create(artifactsToSave);

            return mapSimpleModelToEntity(
                organizationArtifactsExecutionSaved,
                OrganizationArtifactsEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<IOrganizationArtifacts>,
        data: Partial<IOrganizationArtifacts>,
    ): Promise<OrganizationArtifactsEntity> {
        try {
            const organizationArtifact = await this.organizationArtifactsModel
                .findOne(filter)
                .lean()
                .exec();

            await this.organizationArtifactsModel
                .updateOne(filter, {
                    ...organizationArtifact,
                    ...data,
                })
                .exec();

            return this.findOne({ uuid: organizationArtifact._id.toString() });
        } catch (error) {
            console.log(error);
        }
    }
    async delete(uuid: string): Promise<void> {
        try {
            await this.organizationArtifactsModel
                .deleteOne({ _id: uuid })
                .exec();
        } catch (error) {
            console.error('Error deleting organization artifact:', error);
            throw error;
        }
    }
    async find(
        filter?: Partial<IOrganizationArtifacts>,
    ): Promise<OrganizationArtifactsEntity[]> {
        try {
            const organizationArtifacts = await this.organizationArtifactsModel
                .find(
                    {
                        ...filter,
                    },
                    null,
                    { skip: 1 },
                )
                .exec();

            return mapSimpleModelsToEntities(
                organizationArtifacts,
                OrganizationArtifactsEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }
    getNativeCollection() {
        try {
            const nativeConnection =
                this.organizationArtifactsModel.db.collection(
                    'organizationArtifact',
                );

            return nativeConnection;
        } catch (error) {
            console.log(error);
        }
    }
    async findOne(
        filter?: Partial<IOrganizationArtifacts>,
    ): Promise<OrganizationArtifactsEntity> {
        try {
            const organizationArtifact = await this.organizationArtifactsModel
                .findOne(filter)
                .exec();

            return mapSimpleModelToEntity(
                organizationArtifact,
                OrganizationArtifactsEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }
    async getMostRecentArtifacts(
        organizationAndTeamData: OrganizationAndTeamData,
        frequenceType?: string,
    ): Promise<OrganizationArtifactsEntity[]> {
        try {
            const matchCondition: any = {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
            };

            if (frequenceType !== undefined && frequenceType !== null) {
                matchCondition.frequenceType = frequenceType;
            }

            const organizationArtifacts = await this.organizationArtifactsModel
                .aggregate([
                    // Step 1: Filter by organizationId and teamId
                    {
                        $match: matchCondition,
                    },

                    // Step 2: Sort the documents by analysisFinalDate in descending order
                    { $sort: { analysisFinalDate: -1 } },

                    // Step 3: Group all documents to find the maximum (most recent) date
                    {
                        $group: {
                            _id: null, // Group all documents together
                            mostRecentDate: { $max: '$analysisFinalDate' }, // Find the most recent date
                        },
                    },

                    // Step 4: Use the result from the previous step to filter all documents with the most recent date
                    {
                        $lookup: {
                            from: 'teamArtifacts', // Uses the collection name from the model
                            let: { mostRecentDate: '$mostRecentDate' },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: {
                                            $and: [
                                                {
                                                    $eq: [
                                                        '$analysisFinalDate',
                                                        '$$mostRecentDate',
                                                    ],
                                                },
                                                {
                                                    $eq: [
                                                        '$organizationId',
                                                        organizationAndTeamData.organizationId,
                                                    ],
                                                },
                                                {
                                                    $eq: [
                                                        '$teamId',
                                                        organizationAndTeamData.teamId,
                                                    ],
                                                },
                                            ],
                                        },
                                    },
                                },
                            ],
                            as: 'mostRecentDocuments',
                        },
                    },

                    // Step 5: Unwind the found documents
                    { $unwind: '$mostRecentDocuments' },

                    // Step 6: Replace the root document with the most recent documents
                    { $replaceRoot: { newRoot: '$mostRecentDocuments' } },
                ])
                .exec();

            return mapSimpleModelsToEntities(
                organizationArtifacts,
                OrganizationArtifactsEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }
    async getOrganizationArtifactsByWeeksLimit(
        organizationAndTeamData: OrganizationAndTeamData,
        weeksLimit: number,
        frequenceType?: string,
    ): Promise<OrganizationArtifactsEntity[]> {
        try {
            const currentDate = new Date();
            const weeksAgoDate = new Date();
            weeksAgoDate.setDate(currentDate.getDate() - weeksLimit * 7); // Calculates the date N weeks ago

            const filteredTeamId = organizationAndTeamData.teamId
                ? { teamId: organizationAndTeamData.teamId }
                : null;

            const matchCondition: any = {
                organizationId: organizationAndTeamData.organizationId,
                ...filteredTeamId,
            };

            if (frequenceType !== undefined && frequenceType !== null) {
                matchCondition.frequenceType = frequenceType;
            }

            const organizationArtifacts = await this.organizationArtifactsModel
                .aggregate([
                    // Step 1: Filter by organizationId, teamId, and analysisFinalDate within the limit of N weeks
                    {
                        $match: matchCondition,
                    },
                    // Step 2: Sort the documents by analysisFinalDate in descending order
                    { $sort: { analysisFinalDate: -1 } },
                    // Step 3: Group the documents by analysisFinalDate to form groups of artifacts
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
                organizationArtifacts,
                OrganizationArtifactsEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }
}
