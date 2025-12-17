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
    IPullRequestWithDeliveredSuggestions,
} from '@/core/domain/pullRequests/interfaces/pullRequests.interface';
import { DeliveryStatus } from '@/core/domain/pullRequests/enums/deliveryStatus.enum';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { Repository } from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

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

    async findByNumberAndRepositoryName(
        pullRequestNumber: number,
        repositoryName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null> {
        try {
            const pullRequest = await this.pullRequestsModel.findOne({
                'number': pullRequestNumber,
                'repository.name': repositoryName,
                'organizationId': organizationAndTeamData.organizationId,
            });

            return pullRequest
                ? mapSimpleModelToEntity(pullRequest, PullRequestsEntity)
                : null;
        } catch (error) {
            throw error;
        }
    }

    async findByNumberAndRepositoryId(
        pullRequestNumber: number,
        repositoryName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null> {
        try {
            const pullRequest = await this.pullRequestsModel.findOne({
                'number': pullRequestNumber,
                'repository.id': repositoryName,
                'organizationId': organizationAndTeamData.organizationId,
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
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ISuggestion[]> {
        const result = await this.pullRequestsModel
            .aggregate([
                {
                    $match: {
                        'number': prNumber,
                        'repository.fullName': repoFullName,
                        'organizationId':
                            organizationAndTeamData.organizationId,
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

    async findSuggestionsByRuleId(
        ruleId: string,
        organizationId: string,
    ): Promise<ISuggestion[]> {
        try {
            const fileSuggestions = await this.pullRequestsModel
                .aggregate([
                    {
                        $match: {
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
                            'files.suggestions.deliveryStatus': DeliveryStatus.SENT,
                            'files.suggestions.brokenKodyRulesIds': ruleId,
                        },
                    },
                    {
                        $addFields: {
                            'files.suggestions.prNumber': '$number',
                            'files.suggestions.prTitle': '$title',
                            'files.suggestions.prUrl': '$url',
                            'files.suggestions.repositoryId': '$repository.id',
                            'files.suggestions.repositoryFullName':
                                '$repository.fullName',
                        },
                    },
                    {
                        $replaceRoot: {
                            newRoot: '$files.suggestions',
                        },
                    },
                ])
                .exec();

            const prLevelSuggestions = await this.pullRequestsModel
                .aggregate([
                    {
                        $match: {
                            organizationId: organizationId,
                        },
                    },
                    {
                        $unwind: '$prLevelSuggestions',
                    },
                    {
                        $match: {
                            'prLevelSuggestions.deliveryStatus': DeliveryStatus.SENT,
                            'prLevelSuggestions.brokenKodyRulesIds': ruleId,
                        },
                    },
                    {
                        $addFields: {
                            'prLevelSuggestions.prNumber': '$number',
                            'prLevelSuggestions.prTitle': '$title',
                            'prLevelSuggestions.prUrl': '$url',
                            'prLevelSuggestions.repositoryId': '$repository.id',
                            'prLevelSuggestions.repositoryFullName':
                                '$repository.fullName',
                        },
                    },
                    {
                        $replaceRoot: {
                            newRoot: '$prLevelSuggestions',
                        },
                    },
                ])
                .exec();

            return [...fileSuggestions, ...prLevelSuggestions];
        } catch (error) {
            throw error;
        }
    }

    async findPullRequestsWithDeliveredSuggestions(
        organizationId: string,
        prNumbers: number[],
        status: string | string[],
    ): Promise<IPullRequestWithDeliveredSuggestions[]> {
        try {
            const statusFilter = Array.isArray(status)
                ? { $in: status }
                : status;

            const result = await this.pullRequestsModel
                .aggregate([
                    {
                        $match: {
                            organizationId: organizationId,
                            number: { $in: prNumbers },
                            status: statusFilter,
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
                            'files.suggestions.deliveryStatus': {
                                $in: [true, 'sent', 'implemented'],
                            },
                            'files.suggestions.comment.id': {
                                $exists: true,
                                $ne: null,
                            },
                        },
                    },
                    {
                        $group: {
                            _id: '$_id',
                            number: { $first: '$number' },
                            organizationId: { $first: '$organizationId' },
                            status: { $first: '$status' },
                            repositoryId: { $first: '$repository.id' },
                            repositoryName: { $first: '$repository.name' },
                            provider: { $first: '$provider' },
                            suggestions: {
                                $push: {
                                    id: '$files.suggestions.id',
                                    deliveryStatus:
                                        '$files.suggestions.deliveryStatus',
                                    comment: '$files.suggestions.comment',
                                },
                            },
                        },
                    },
                    {
                        $project: {
                            _id: 1,
                            number: 1,
                            organizationId: 1,
                            status: 1,
                            repository: {
                                id: '$repositoryId',
                                name: '$repositoryName',
                            },
                            provider: 1,
                            suggestions: 1,
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
        batchSize: number = 50,
    ): Promise<PullRequestsEntity[]> {
        try {
            if (!organizationId || !repository?.id) {
                throw new Error('Missing organizationId or repositoryId');
            }

            const matchStage: Record<string, any> = {
                organizationId,
                'repository.id': repository.id.toString(),
            };

            if (syncedEmbeddedSuggestions !== undefined) {
                matchStage.syncedEmbeddedSuggestions = {
                    $ne: !syncedEmbeddedSuggestions,
                };
            }

            if (status) {
                matchStage.status = status;
            }

            /* ---------- regex para validar UUID no $expr/$regexMatch ---------- */
            const UUID_REGEX =
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-' +
                '[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

            const pipeline = [
                { $match: matchStage },
                {
                    $addFields: {
                        files: {
                            $filter: {
                                input: { $ifNull: ['$files', []] },
                                as: 'file',
                                cond: {
                                    $gt: [
                                        {
                                            $size: {
                                                $ifNull: [
                                                    '$$file.suggestions',
                                                    [],
                                                ],
                                            },
                                        },
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                },
                { $match: { $expr: { $gt: [{ $size: '$files' }, 0] } } },
                {
                    $addFields: {
                        files: {
                            $map: {
                                input: '$files',
                                as: 'f',
                                in: {
                                    id: '$$f.id',
                                    sha: '$$f.sha',
                                    path: '$$f.path',
                                    filename: '$$f.filename',
                                    status: '$$f.status',

                                    suggestions: {
                                        $filter: {
                                            input: '$$f.suggestions',
                                            as: 's',
                                            cond: {
                                                $and: [
                                                    { $ne: ['$$s.id', null] },
                                                    { $ne: ['$$s.id', ''] },
                                                    {
                                                        $regexMatch: {
                                                            input: '$$s.id',
                                                            regex: UUID_REGEX,
                                                        },
                                                    },
                                                ],
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                {
                    $project: {
                        '_id': 1,
                        'uuid': 1,
                        'number': 1,
                        'organizationId': 1,
                        'syncedEmbeddedSuggestions': 1,
                        'repository.id': 1,
                        'repository.fullName': 1,
                        'files': 1,
                    },
                },
            ];

            const cursor = this.pullRequestsModel
                .aggregate(pipeline)
                .allowDiskUse(true)
                .cursor({ batchSize });

            const result: PullRequestsEntity[] = [];
            for await (const pr of cursor) {
                result.push(mapSimpleModelToEntity(pr, PullRequestsEntity));
            }

            return result;
        } catch (error) {
            throw error;
        }
    }

    async findByOrganizationAndRepositoryWithStatusAndSyncedWithIssuesFlag(
        organizationId: string,
        repository: Pick<Repository, 'id' | 'fullName'>,
        status?: PullRequestState,
        syncedWithIssues?: boolean,
        batchSize: number = 50,
    ): Promise<PullRequestsEntity[]> {
        try {
            if (!organizationId || !repository?.id) {
                throw new Error('Missing organizationId or repositoryId');
            }

            const matchStage: Record<string, any> = {
                organizationId,
                'repository.id': repository.id.toString(),
            };

            if (syncedWithIssues !== undefined) {
                matchStage.syncedWithIssues = {
                    $ne: !syncedWithIssues,
                };
            }

            if (status) {
                matchStage.status = status;
            }

            /* ---------- regex para validar UUID no $expr/$regexMatch ---------- */
            const UUID_REGEX =
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-' +
                '[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

            const pipeline = [
                { $match: matchStage },
                {
                    $addFields: {
                        files: {
                            $filter: {
                                input: '$files',
                                as: 'file',
                                cond: {
                                    $gt: [{ $size: '$$file.suggestions' }, 0],
                                },
                            },
                        },
                    },
                },
                { $match: { $expr: { $gt: [{ $size: '$files' }, 0] } } },
                {
                    $addFields: {
                        files: {
                            $map: {
                                input: '$files',
                                as: 'f',
                                in: {
                                    id: '$$f.id',
                                    sha: '$$f.sha',
                                    path: '$$f.path',
                                    filename: '$$f.filename',
                                    status: '$$f.status',

                                    suggestions: {
                                        $filter: {
                                            input: '$$f.suggestions',
                                            as: 's',
                                            cond: {
                                                $and: [
                                                    { $ne: ['$$s.id', null] },
                                                    { $ne: ['$$s.id', ''] },
                                                    {
                                                        $regexMatch: {
                                                            input: '$$s.id',
                                                            regex: UUID_REGEX,
                                                        },
                                                    },
                                                ],
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                {
                    $project: {
                        '_id': 1,
                        'uuid': 1,
                        'number': 1,
                        'organizationId': 1,
                        'syncedEmbeddedSuggestions': 1,
                        'repository.id': 1,
                        'repository.fullName': 1,
                        'files': 1,
                    },
                },
            ];

            const cursor = this.pullRequestsModel
                .aggregate(pipeline)
                .allowDiskUse(true)
                .cursor({ batchSize });

            const result: PullRequestsEntity[] = [];
            for await (const pr of cursor) {
                result.push(mapSimpleModelToEntity(pr, PullRequestsEntity));
            }

            return result;
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

    async findRecentByRepositoryId(
        organizationId: string,
        repositoryId: string,
        limit: number = 10,
    ): Promise<PullRequestsEntity[]> {
        try {
            const docs = await this.pullRequestsModel
                .find({
                    'organizationId': organizationId,
                    'repository.id': repositoryId,
                })
                .sort({ openedAt: -1, createdAt: -1 })
                .limit(limit)
                .exec();

            return mapSimpleModelsToEntities(docs, PullRequestsEntity);
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
        const sanitizedData: Partial<IFile> = {};

        Object.keys(updateData).forEach((key) => {
            if (key === 'reviewMode') {
                if (
                    updateData.reviewMode &&
                    updateData.reviewMode.toString() !== ''
                ) {
                    sanitizedData.reviewMode = updateData.reviewMode;
                }
            } else if (key === 'codeReviewModelUsed') {
                if (typeof updateData.codeReviewModelUsed === 'object') {
                    const modelUsed: any = {};

                    if (
                        updateData.codeReviewModelUsed.generateSuggestions &&
                        updateData.codeReviewModelUsed.generateSuggestions.toString() !==
                            ''
                    ) {
                        modelUsed.generateSuggestions =
                            updateData.codeReviewModelUsed.generateSuggestions;
                    }

                    if (
                        updateData.codeReviewModelUsed.safeguard &&
                        updateData.codeReviewModelUsed.safeguard.toString() !==
                            ''
                    ) {
                        modelUsed.safeguard =
                            updateData.codeReviewModelUsed.safeguard;
                    }

                    if (Object.keys(modelUsed).length > 0) {
                        sanitizedData.codeReviewModelUsed = modelUsed;
                    }
                }
            } else {
                (sanitizedData as any)[key] = (updateData as any)[key];
            }
        });

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
        pullRequestNumbers: number[],
        repositoryId: string,
        organizationId: string,
        synced: boolean,
    ): Promise<void> {
        try {
            const validNumbers = pullRequestNumbers.filter(
                (n) => typeof n === 'number',
            );

            if (!validNumbers?.length) {
                return null;
            }

            const filter = {
                'number': { $in: validNumbers },
                'repository.id': repositoryId,
                'organizationId': organizationId,
            };

            const update = { $set: { syncedEmbeddedSuggestions: synced } };

            await this.pullRequestsModel.updateMany(filter, update);
        } catch (error) {
            throw error;
        }
    }

    async updateSyncedWithIssuesFlag(
        prNumber: number,
        repositoryId: string,
        organizationId: string,
        synced: boolean,
    ): Promise<void> {
        try {
            if (!prNumber) {
                return null;
            }

            const filter = {
                'number': prNumber,
                'repository.id': repositoryId,
                'organizationId': organizationId,
            };

            const update = { $set: { syncedWithIssues: synced } };

            await this.pullRequestsModel.updateOne(filter, update);
        } catch (error) {
            throw error;
        }
    }
    //#endregion
}
