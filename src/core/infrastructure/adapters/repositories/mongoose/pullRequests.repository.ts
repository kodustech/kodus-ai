import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { PullRequestsModel } from './schema/pullRequests.model';
import { IPullRequestsRepository } from '@/core/domain/pullRequests/contracts/pullRequests.repository';
import { PullRequestsEntity } from '@/core/domain/pullRequests/entities/pullRequests.entity';
import mongoose from 'mongoose';
import {
    ISuggestion,
    IFile,
    IPullRequests,
} from '@/core/domain/pullRequests/interfaces/pullRequests.interface';
import { DeliveryStatus } from '@/core/domain/pullRequests/enums/deliveryStatus.enum';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { Repository } from '@/config/types/general/codeReview.type';

@Injectable()
export class PullRequestsRepository implements IPullRequestsRepository {
    constructor(
        @InjectModel(PullRequestsModel.name)
        private readonly pullRequestsModel: Model<PullRequestsModel>,
    ) {}

    getNativeCollection() {
        try {
            return this.pullRequestsModel.db.collection('pullRequests');
        } catch (error) {
            throw error;
        }
    }

    //#region Create
    async create(
        suggestion: Omit<IPullRequests, 'uuid'>,
    ): Promise<PullRequestsEntity> {
        try {
            const saved = await this.pullRequestsModel.create(suggestion);
            return mapSimpleModelToEntity(saved, PullRequestsEntity);
        } catch (error) {
            throw error;
        }
    }
    //#endregion

    //#region Get/Find
    async findById(uuid: string): Promise<PullRequestsEntity | null> {
        try {
            const doc = await this.pullRequestsModel.findOne({ uuid }).exec();
            return doc ? mapSimpleModelToEntity(doc, PullRequestsEntity) : null;
        } catch (error) {
            throw error;
        }
    }

    async findOne(
        filter?: Partial<IPullRequests>,
    ): Promise<PullRequestsEntity | null> {
        try {
            const doc = await this.pullRequestsModel.findOne(filter).exec();
            return doc ? mapSimpleModelToEntity(doc, PullRequestsEntity) : null;
        } catch (error) {
            throw error;
        }
    }

    async find(filter?: Partial<IPullRequests>): Promise<PullRequestsEntity[]> {
        try {
            const docs = await this.pullRequestsModel.find(filter).exec();
            return mapSimpleModelsToEntities(docs, PullRequestsEntity);
        } catch (error) {
            throw error;
        }
    }

    async findByNumberAndRepository(
        pullRequestNumber: number,
        repositoryName: string,
    ): Promise<PullRequestsEntity | null> {
        try {
            const pullRequest = await this.pullRequestsModel.findOne({
                'number': pullRequestNumber,
                'repository.name': repositoryName,
            });

            return pullRequest
                ? mapSimpleModelToEntity(pullRequest, PullRequestsEntity)
                : null;
        } catch (error) {
            throw error;
        }
    }

    async findFileWithSuggestions(
        prnumber: number,
        repositoryName: string,
        filePath: string,
    ): Promise<IFile | null> {
        const result = await this.pullRequestsModel
            .aggregate([
                {
                    $match: {
                        'number': prnumber,
                        'repository.name': repositoryName,
                    },
                },
                {
                    $unwind: '$files',
                },
                {
                    $match: {
                        'files.path': filePath,
                    },
                },
                {
                    $replaceRoot: {
                        newRoot: '$files',
                    },
                },
            ])
            .exec();

        return result[0] || null;
    }

    async findSuggestionsByPRAndFilename(
        prNumber: number,
        repoFullName: string,
        filename: string,
    ): Promise<ISuggestion[]> {
        const result = await this.pullRequestsModel
            .aggregate([
                {
                    $match: {
                        'number': prNumber,
                        'repository.fullName': repoFullName,
                    },
                },
                {
                    $unwind: '$files',
                },
                {
                    $match: {
                        'files.path': filename,
                    },
                },
                {
                    $project: {
                        suggestions: '$files.suggestions',
                    },
                },
                {
                    $unwind: '$suggestions',
                },
                {
                    $replaceRoot: {
                        newRoot: '$suggestions',
                    },
                },
            ])
            .exec();

        return result;
    }

    async findSuggestionsByPR(
        organizationId: string,
        prNumber: number,
        deliveryStatus: DeliveryStatus,
    ): Promise<ISuggestion[]> {
        try {
            const result = await this.pullRequestsModel
                .aggregate([
                    {
                        $match: {
                            number: prNumber,
                            organizationId: organizationId,
                        },
                    },
                    {
                        $unwind: '$files',
                    },
                    {
                        $unwind: '$files.suggestions',
                    },
                    {
                        $match: {
                            'files.suggestions.deliveryStatus': deliveryStatus,
                        },
                    },
                    {
                        $replaceRoot: {
                            newRoot: '$files.suggestions',
                        },
                    },
                ])
                .exec();

            return result;
        } catch (error) {
            throw error;
        }
    }

    async findByOrganizationAndRepositoryWithStatusAndSyncedFlag(
        organizationId: string,
        repository: Pick<Repository, 'id' | 'fullName'>,
        status?: PullRequestState,
        syncedEmbeddedSuggestions?: boolean,
    ): Promise<PullRequestsEntity[]> {
        try {
            if (!organizationId || !repository || !repository?.id) {
                throw new Error(
                    `Missing organizationId or repositoryId. org: ${organizationId}, repo.id: ${repository?.id}, repo: ${JSON.stringify(repository)}`,
                );
            }

            const filter: any = {
                organizationId,
                'repository.id': repository.id.toString(),
            };

            if (status) {
                filter.status = status;
            }

            if (syncedEmbeddedSuggestions !== undefined) {
                filter['$or'] = [
                    { syncedEmbeddedSuggestions },
                    { syncedEmbeddedSuggestions: { $exists: false } },
                ];
            }

            const docs = await this.pullRequestsModel.find(filter).exec();

            return mapSimpleModelsToEntities(docs, PullRequestsEntity);
        } catch (error) {
            throw error;
        }
    }

    //#endregion

    //#region Add
    async addFileToPullRequest(
        pullRequestNumber: number,
        repositoryName: string,
        newFile: Omit<IFile, 'id'>,
    ): Promise<PullRequestsEntity | null> {
        try {
            const doc = await this.pullRequestsModel
                .findOneAndUpdate(
                    {
                        'number': pullRequestNumber,
                        'repository.name': repositoryName,
                    },
                    {
                        $push: {
                            files: {
                                ...newFile,
                                id: new mongoose.Types.ObjectId().toString(),
                            },
                        },
                    },
                    {
                        new: true,
                    },
                )
                .exec();

            return doc ? mapSimpleModelToEntity(doc, PullRequestsEntity) : null;
        } catch (error) {
            throw error;
        }
    }

    async addSuggestionToFile(
        fileId: string,
        newSuggestion: Omit<ISuggestion, 'id'> & { id?: string },
        pullRequestNumber: number,
        repositoryName: string,
    ): Promise<PullRequestsEntity | null> {
        try {
            const suggestionWithId = {
                ...newSuggestion,
                id:
                    newSuggestion.id ||
                    new mongoose.Types.ObjectId().toString(),
            };

            const doc = await this.pullRequestsModel
                .findOneAndUpdate(
                    {
                        'number': pullRequestNumber,
                        'repository.name': repositoryName,
                        'files.id': fileId,
                    },
                    {
                        $push: {
                            'files.$.suggestions': suggestionWithId,
                        },
                    },
                    { new: true },
                )
                .exec();

            return doc ? mapSimpleModelToEntity(doc, PullRequestsEntity) : null;
        } catch (error) {
            throw error;
        }
    }
    //#endregion

    //#region Update
    async update(
        pullRequest: PullRequestsEntity,
        updateData: Omit<Partial<IPullRequests>, 'uuid' | 'id'>,
    ): Promise<PullRequestsEntity | null> {
        try {
            const doc = await this.pullRequestsModel.findOneAndUpdate(
                { _id: pullRequest.uuid },
                { $set: updateData },
                { new: true },
            );
            return doc ? mapSimpleModelToEntity(doc, PullRequestsEntity) : null;
        } catch (error) {
            throw error;
        }
    }

    async updateFile(
        fileId: string,
        updateData: Partial<IFile>,
    ): Promise<PullRequestsEntity | null> {
        try {
            const sanitizedUpdateData =
                this.sanitizeCodeReviewConfigData(updateData);

            const doc = await this.pullRequestsModel
                .findOneAndUpdate(
                    { 'files.id': fileId },
                    {
                        $set: Object.entries(sanitizedUpdateData).reduce(
                            (acc, [key, value]) => ({
                                ...acc,
                                [`files.$.${key}`]: value,
                            }),
                            {
                                'files.$.updatedAt': new Date().toISOString(),
                            },
                        ),
                    },
                    { new: true },
                )
                .exec();

            return doc ? mapSimpleModelToEntity(doc, PullRequestsEntity) : null;
        } catch (error) {
            throw error;
        }
    }

    private sanitizeCodeReviewConfigData(
        updateData: Partial<IFile>,
    ): Partial<IFile> {
        const sanitizedData = { ...updateData };

        if (!updateData.reviewMode || updateData.reviewMode.toString() === '') {
            delete sanitizedData?.reviewMode;
        }

        if (typeof sanitizedData.codeReviewModelUsed === 'object') {
            const { generateSuggestions, safeguard } =
                sanitizedData.codeReviewModelUsed;

            if (!generateSuggestions || generateSuggestions.toString() === '') {
                delete sanitizedData?.codeReviewModelUsed?.generateSuggestions;
            }

            if (!safeguard || safeguard.toString() === '') {
                delete sanitizedData?.codeReviewModelUsed?.safeguard;
            }
        }

        if (
            !sanitizedData.codeReviewModelUsed ||
            Object.keys(sanitizedData.codeReviewModelUsed).length === 0
        ) {
            delete sanitizedData.codeReviewModelUsed;
            return sanitizedData;
        }
        return sanitizedData;
    }

    async updateSuggestion(
        suggestionId: string,
        updateData: Partial<ISuggestion>,
    ): Promise<PullRequestsEntity | null> {
        try {
            const updateFields = Object.entries(updateData).reduce(
                (acc, [key, value]) => {
                    acc[`files.$[file].suggestions.$[suggestion].${key}`] =
                        value;
                    return acc;
                },
                {},
            );

            const doc = await this.pullRequestsModel
                .findOneAndUpdate(
                    { 'files.suggestions.id': suggestionId },
                    { $set: updateFields },
                    {
                        arrayFilters: [
                            { 'file.suggestions.id': suggestionId },
                            { 'suggestion.id': suggestionId },
                        ],
                        new: true,
                    },
                )
                .exec();

            return doc ? mapSimpleModelToEntity(doc, PullRequestsEntity) : null;
        } catch (error) {
            throw error;
        }
    }

    async updateSyncedSuggestionsFlag(
        pullRequestNumber: number,
        repositoryId: string,
        organizationId: string,
        synced: boolean,
    ): Promise<PullRequestsEntity | null> {
        try {
            const doc = await this.pullRequestsModel.findOneAndUpdate(
                {
                    'number': pullRequestNumber,
                    'repository.id': repositoryId,
                    'organizationId': organizationId,
                },
                { $set: { syncedEmbeddedSuggestions: synced } },
                { new: true },
            );

            return doc ? mapSimpleModelToEntity(doc, PullRequestsEntity) : null;
        } catch (error) {
            throw error;
        }
    }
    //#endregion
}
