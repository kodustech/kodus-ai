import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import mongoose from 'mongoose';
import { PullRequestsModel } from './schemas/pullRequests.model';

import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@libs/core/infrastructure/repositories/mappers';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { Repository } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PullRequestState } from '@libs/core/domain/enums';
import {
    BulkApplyError,
    BulkApplyResult,
    FileBulkOp,
    IPullRequestsRepository,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.repository';
import {
    IFile,
    IPullRequests,
    IPullRequestUserMapping,
    IPullRequestWithDeliveredSuggestions,
    ISuggestion,
} from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { PullRequestsEntity } from '@libs/platformData/domain/pullRequests/entities/pullRequests.entity';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';

@Injectable()
export class PullRequestsRepository implements IPullRequestsRepository {
    constructor(
        @InjectModel(PullRequestsModel.name)
        private readonly pullRequestsModel: Model<PullRequestsModel>,
    ) {}

    getNativeCollection() {
        return this.pullRequestsModel.db.collection('pullRequests');
    }

    //#region Create
    async create(
        suggestion: Omit<IPullRequests, 'uuid'>,
    ): Promise<PullRequestsEntity> {
        const saved = await this.pullRequestsModel.create(suggestion as any);
        return mapSimpleModelToEntity(saved, PullRequestsEntity);
    }
    //#endregion

    //#region Get/Find
    async findById(uuid: string): Promise<PullRequestsEntity | null> {
        const doc = await this.pullRequestsModel
            .findOne({ uuid })
            .lean()
            .exec();
        return doc ? mapSimpleModelToEntity(doc, PullRequestsEntity) : null;
    }

    async findOne(
        filter?: Partial<IPullRequests>,
    ): Promise<PullRequestsEntity | null> {
        const doc = await this.pullRequestsModel
            .findOne(filter as any)
            .lean()
            .exec();
        return doc ? mapSimpleModelToEntity(doc, PullRequestsEntity) : null;
    }

    async find(filter?: Partial<IPullRequests>): Promise<PullRequestsEntity[]> {
        const docs = await this.pullRequestsModel
            .find(filter as any)
            .lean()
            .exec();
        return mapSimpleModelsToEntities(docs, PullRequestsEntity);
    }

    async findPRNumbersByTitleAndOrganization(
        title: string,
        organizationId: string,
        repositoryIds?: string[],
    ): Promise<Array<{ number: number; repositoryId: string }>> {
        const filter: any = {
            organizationId,
            title: { $regex: title, $options: 'i' },
        };

        if (repositoryIds?.length) {
            filter['repository.id'] = { $in: repositoryIds };
        }

        const results = await this.pullRequestsModel
            .find(filter, { 'number': 1, 'repository.id': 1 })
            .lean()
            .exec();

        return results.map((doc) => ({
            number: doc.number,
            repositoryId: doc.repository?.id || '',
        }));
    }

    async findByNumberAndRepositoryName(
        pullRequestNumber: number,
        repositoryName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null> {
        const pullRequest = await this.pullRequestsModel
            .findOne({
                'number': pullRequestNumber,
                'repository.name': repositoryName,
                'organizationId': organizationAndTeamData.organizationId,
            })
            .lean();

        return pullRequest
            ? mapSimpleModelToEntity(pullRequest, PullRequestsEntity)
            : null;
    }

    async findByNumberAndRepositoryId(
        pullRequestNumber: number,
        repositoryName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null> {
        const pullRequest = await this.pullRequestsModel
            .findOne({
                'number': pullRequestNumber,
                'repository.id': repositoryName,
                'organizationId': organizationAndTeamData.organizationId,
            })
            .lean();

        return pullRequest
            ? mapSimpleModelToEntity(pullRequest, PullRequestsEntity)
            : null;
    }

    async findByNumberAndRepositoryIdOptimized(
        pullRequestNumber: number,
        repositoryId: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null> {
        // Use projection to exclude heavy fields (files.suggestions details)
        const pullRequest = await this.pullRequestsModel
            .findOne(
                {
                    'number': pullRequestNumber,
                    'repository.id': repositoryId,
                    'organizationId': organizationAndTeamData.organizationId,
                },
                {
                    // Exclude suggestion content but keep count
                    'files.suggestions.existingCode': 0,
                    'files.suggestions.improvedCode': 0,
                    'files.suggestions.suggestionContent': 0,
                    'commits': 0,
                    'prLevelSuggestions': 0,
                },
            )
            .lean();

        return pullRequest
            ? mapSimpleModelToEntity(pullRequest, PullRequestsEntity)
            : null;
    }

    async findManyByNumbersAndRepositoryIds(
        criteria: Array<{
            number: number;
            repositoryId: string;
        }>,
        organizationId: string,
    ): Promise<PullRequestsEntity[]> {
        if (!criteria.length) {
            return [];
        }

        const orConditions = criteria.map((c) => ({
            'number': c.number,
            'repository.id': c.repositoryId,
        }));

        const pullRequests = await this.pullRequestsModel
            .find(
                {
                    organizationId,
                    $or: orConditions,
                },
                {
                    // PERF: Exclude heavy fields - suggestion counts come from aggregation
                    // This reduces data transfer from ~3MB to ~50KB per batch
                    files: 0,
                    commits: 0,
                    prLevelSuggestions: 0,
                },
            )
            .lean()
            .exec();

        return mapSimpleModelsToEntities(pullRequests, PullRequestsEntity);
    }

    /**
     * PERF: Batch fetch PRs by organization and PR numbers only.
     * Used for token usage by developer queries where repositoryId is not available.
     * Returns only fields needed for developer mapping (number, user, organizationId).
     */
    async findManyByNumbers(
        prNumbers: number[],
        organizationId: string,
    ): Promise<IPullRequestUserMapping[]> {
        if (!prNumbers.length) {
            return [];
        }

        const pullRequests = await this.pullRequestsModel
            .find(
                {
                    organizationId,
                    number: { $in: prNumbers },
                },
                {
                    // Only fetch fields needed for developer mapping
                    number: 1,
                    user: 1,
                    organizationId: 1,
                },
            )
            .lean()
            .exec();

        return pullRequests.map((pr) => ({
            number: pr.number,
            user: pr.user,
            organizationId: pr.organizationId,
        }));
    }

    /**
     * PERF: Aggregation query that counts suggestions directly in MongoDB.
     *
     * Instead of transferring ~180k suggestion objects to count SENT vs NOT_SENT,
     * this performs the counting in MongoDB and returns only the totals.
     *
     * Performance improvement:
     * - Before: ~3MB of BSON data per batch of 30 PRs
     * - After: ~1KB of data (just counts)
     *
     * @returns Map keyed by `${repositoryId}_${prNumber}` with counts
     */
    async findSuggestionCountsByNumbersAndRepositoryIds(
        criteria: Array<{
            number: number;
            repositoryId: string;
        }>,
        organizationId: string,
    ): Promise<Map<string, { sent: number; filtered: number }>> {
        const result = new Map<string, { sent: number; filtered: number }>();

        if (!criteria.length) {
            return result;
        }

        const orConditions = criteria.map((c) => ({
            'number': c.number,
            'repository.id': c.repositoryId,
        }));

        const aggregationResult = await this.pullRequestsModel
            .aggregate([
                // Match the PRs we need
                {
                    $match: {
                        organizationId,
                        $or: orConditions,
                    },
                },
                // Unwind files array
                {
                    $unwind: {
                        path: '$files',
                        preserveNullAndEmptyArrays: true,
                    },
                },
                // Unwind suggestions array
                {
                    $unwind: {
                        path: '$files.suggestions',
                        preserveNullAndEmptyArrays: true,
                    },
                },
                // Group by PR and count by deliveryStatus
                {
                    $group: {
                        _id: {
                            repositoryId: '$repository.id',
                            prNumber: '$number',
                        },
                        sent: {
                            $sum: {
                                $cond: [
                                    {
                                        $eq: [
                                            '$files.suggestions.deliveryStatus',
                                            DeliveryStatus.SENT,
                                        ],
                                    },
                                    1,
                                    0,
                                ],
                            },
                        },
                        filtered: {
                            $sum: {
                                $cond: [
                                    {
                                        $eq: [
                                            '$files.suggestions.deliveryStatus',
                                            DeliveryStatus.NOT_SENT,
                                        ],
                                    },
                                    1,
                                    0,
                                ],
                            },
                        },
                    },
                },
                // Project to clean output
                {
                    $project: {
                        _id: 0,
                        repositoryId: '$_id.repositoryId',
                        prNumber: '$_id.prNumber',
                        sent: 1,
                        filtered: 1,
                    },
                },
            ])
            .exec();

        // Build the result map
        for (const row of aggregationResult) {
            const key = `${row.repositoryId}_${row.prNumber}`;
            result.set(key, {
                sent: row.sent || 0,
                filtered: row.filtered || 0,
            });
        }

        return result;
    }

    async findFileWithSuggestions(
        prnumber: number,
        repositoryName: string,
        filePath: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IFile | null> {
        const result = await this.pullRequestsModel
            .aggregate([
                {
                    $match: {
                        'number': prnumber,
                        'repository.name': repositoryName,
                        'organizationId':
                            organizationAndTeamData.organizationId,
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
    }

    async findSuggestionsByRuleId(
        ruleId: string,
        organizationId: string,
    ): Promise<ISuggestion[]> {
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
                        'prLevelSuggestions.deliveryStatus':
                            DeliveryStatus.SENT,
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
    }

    async findPullRequestsWithDeliveredSuggestions(
        organizationId: string,
        prNumbers: number[],
        status: string | string[],
    ): Promise<IPullRequestWithDeliveredSuggestions[]> {
        const statusFilter = Array.isArray(status) ? { $in: status } : status;

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
    }

    async findByOrganizationAndRepositoryWithStatusAndSyncedFlag(
        organizationId: string,
        repository: Pick<Repository, 'id' | 'fullName'>,
        status?: PullRequestState,
        syncedEmbeddedSuggestions?: boolean,
        batchSize: number = 50,
    ): Promise<PullRequestsEntity[]> {
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
                                            $ifNull: ['$$file.suggestions', []],
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
    }

    async findByOrganizationAndRepositoryWithStatusAndSyncedWithIssuesFlag(
        organizationId: string,
        repository: Pick<Repository, 'id' | 'fullName'>,
        status?: PullRequestState,
        syncedWithIssues?: boolean,
        batchSize: number = 50,
    ): Promise<PullRequestsEntity[]> {
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
    }

    //#endregion

    //#region Add
    async addFileToPullRequest(
        pullRequestNumber: number,
        repositoryName: string,
        newFile: Omit<IFile, 'id'>,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null> {
        const doc = await this.pullRequestsModel
            .findOneAndUpdate(
                {
                    'number': pullRequestNumber,
                    'repository.name': repositoryName,
                    'organizationId': organizationAndTeamData.organizationId,
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
    }

    /**
     * Issue #1107: `handleExistingPullRequest` used to iterate
     * `changedFiles` serially, calling `findFileWithSuggestions`
     * + `updateFile` + N × `addSuggestionToFile` per file. A PR with
     * a few thousand files produced ~21k sequential round-trips on
     * a Mongo document that's also approaching the 16MB cap — every
     * webhook event timed out at 180s and the next event repeated
     * the same expensive path. This method collapses everything to
     * a single read followed by a few `bulkWrite` calls.
     *
     * Accepts domain-level ops so the contract doesn't leak Mongo
     * types. Chunks at 200 so any single command stays well under
     * the 16MB per-request limit even when ops carry large payloads.
     */
    async bulkApplyFileChanges(
        prUuid: string,
        organizationId: string,
        ops: FileBulkOp[],
    ): Promise<BulkApplyResult> {
        if (ops.length === 0) {
            return { attempted: 0, modified: 0, errors: [] };
        }
        if (!organizationId) {
            throw new Error(
                'bulkApplyFileChanges requires organizationId for tenant isolation',
            );
        }
        const bulkOps = ops.map((op) =>
            this.translateFileBulkOp(prUuid, organizationId, op),
        );
        const CHUNK_SIZE = 200;
        let modified = 0;
        const errors: BulkApplyError[] = [];

        for (let i = 0; i < bulkOps.length; i += CHUNK_SIZE) {
            const chunk = bulkOps.slice(i, i + CHUNK_SIZE);
            try {
                // ordered: false — one bad op doesn't stop the rest,
                // and every op is self-contained (adds a file or
                // pushes suggestions onto an existing file by id).
                const res = await this.pullRequestsModel.bulkWrite(
                    chunk,
                    { ordered: false },
                );
                modified += (res?.modifiedCount ?? 0) + (res?.upsertedCount ?? 0);
            } catch (err: unknown) {
                // MongoBulkWriteError still carries the partial result
                // on `err.result` plus `err.writeErrors[]`. With
                // ordered:false the unaffected ops in the chunk
                // commit even when a few fail — we surface the
                // failures up the stack instead of swallowing them.
                const e = err as {
                    result?: { modifiedCount?: number };
                    writeErrors?: Array<{
                        index?: number;
                        code?: number;
                        errmsg?: string;
                    }>;
                    message?: string;
                };
                modified += e?.result?.modifiedCount ?? 0;
                const writeErrors = e?.writeErrors ?? [];
                if (writeErrors.length === 0) {
                    errors.push({
                        opIndex: i,
                        code: undefined,
                        message: e?.message ?? 'bulkWrite failed',
                    });
                } else {
                    for (const we of writeErrors) {
                        errors.push({
                            opIndex: i + (we.index ?? 0),
                            code: we.code,
                            message: we.errmsg ?? 'write error',
                        });
                    }
                }
            }
        }

        return { attempted: bulkOps.length, modified, errors };
    }

    /**
     * Server-side aggregation that returns totals derived from the
     * current `files` array without transferring the array itself.
     *
     * Used by `handleExistingPullRequest` to recompute
     * `totalAdded/totalDeleted/totalChanges` from ground truth after
     * a `bulkApplyFileChanges` run, so the totals can never drift
     * from the actual sub-documents even if a chunk partially failed.
     */
    async computeFileTotals(
        prUuid: string,
        organizationId: string,
    ): Promise<{
        totalAdded: number;
        totalDeleted: number;
        totalChanges: number;
    }> {
        if (!organizationId) {
            throw new Error(
                'computeFileTotals requires organizationId for tenant isolation',
            );
        }
        // Aggregation does NOT auto-cast string → ObjectId the way
        // standard query operators do, so build the ObjectId here.
        // The id may not be a valid 24-char hex (e.g. legacy data or
        // tests that synthesize uuids); fall back to string match
        // rather than throwing.
        const match: Record<string, unknown> = {
            organizationId,
            ...(mongoose.Types.ObjectId.isValid(prUuid)
                ? { _id: new mongoose.Types.ObjectId(prUuid) }
                : { _id: prUuid }),
        };
        const result = await this.pullRequestsModel
            .aggregate<{
                totalAdded: number;
                totalDeleted: number;
                totalChanges: number;
            }>([
                { $match: match },
                {
                    $project: {
                        _id: 0,
                        totalAdded: {
                            $sum: { $ifNull: ['$files.added', 0] },
                        },
                        totalDeleted: {
                            $sum: { $ifNull: ['$files.deleted', 0] },
                        },
                        totalChanges: {
                            $sum: { $ifNull: ['$files.changes', 0] },
                        },
                    },
                },
            ])
            .exec();
        const row = result?.[0];
        return {
            totalAdded: row?.totalAdded ?? 0,
            totalDeleted: row?.totalDeleted ?? 0,
            totalChanges: row?.totalChanges ?? 0,
        };
    }

    private translateFileBulkOp(
        prUuid: string,
        organizationId: string,
        op: FileBulkOp,
    ): mongoose.mongo.AnyBulkWriteOperation<PullRequestsModel> {
        // `uuid` is exposed on the entity by the simple-mapper as
        // `_id.toString()`. The doc itself only carries `_id`, so the
        // bulk filter must use `_id` — Mongoose auto-casts the string
        // to ObjectId on the way in. This mirrors `update(...)` above
        // and is the same trick `addFileToPullRequest` uses.
        //
        // `organizationId` is ANDed in for tenant isolation: an
        // ObjectId is globally unique, but defense-in-depth prevents
        // a stale uuid (e.g. from a swapped context) from ever
        // matching a doc that belongs to another tenant.
        const prFilter = {
            _id: prUuid,
            organizationId,
        } as Record<string, unknown>;
        switch (op.kind) {
            case 'addFile':
                return {
                    updateOne: {
                        filter: prFilter,
                        update: { $push: { files: op.file as any } },
                    },
                };
            case 'updateFile': {
                // Reuse the same sanitizer that the per-file
                // `updateFile()` method has applied historically.
                // It drops empty/blank `reviewMode` and trims empty
                // sub-fields from `codeReviewModelUsed` so webhook
                // payloads (which never carry these pipeline-owned
                // fields) cannot clobber values written by later
                // review stages.
                const sanitized = this.sanitizeCodeReviewConfigData(
                    op.data as Partial<{
                        reviewMode: unknown;
                        codeReviewModelUsed: unknown;
                    }> as any,
                );
                const $set: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(sanitized)) {
                    $set[`files.$.${k}`] = v;
                }
                return {
                    updateOne: {
                        filter: { ...prFilter, 'files.id': op.fileId },
                        update: { $set },
                    },
                };
            }
            case 'addSuggestions':
                return {
                    updateOne: {
                        filter: { ...prFilter, 'files.id': op.fileId },
                        update: {
                            $push: {
                                'files.$.suggestions': {
                                    $each: op.suggestions as any[],
                                },
                            },
                        },
                    },
                };
        }
    }

    /**
     * Stable generator for sub-document ids used in `bulkApplyFileChanges`.
     * Exposed on the repository so the service can pre-compute file/
     * suggestion ids before the bulkWrite — the alternative (letting
     * Mongo generate during $push) doesn't return the new ids in a
     * shape we can use to reference suggestions later.
     */
    newSubDocumentId(): string {
        return new mongoose.Types.ObjectId().toString();
    }

    async addSuggestionToFile(
        fileId: string,
        newSuggestion: Omit<ISuggestion, 'id'> & { id?: string },
        pullRequestNumber: number,
        repositoryName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null> {
        const suggestionWithId = {
            ...newSuggestion,
            id: newSuggestion.id || new mongoose.Types.ObjectId().toString(),
        };

        const doc = await this.pullRequestsModel
            .findOneAndUpdate(
                {
                    'number': pullRequestNumber,
                    'repository.name': repositoryName,
                    'organizationId': organizationAndTeamData.organizationId,
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
    }

    async findRecentByRepositoryId(
        organizationId: string,
        repositoryId: string,
        limit: number = 10,
    ): Promise<PullRequestsEntity[]> {
        const docs = await this.pullRequestsModel
            .find({
                'organizationId': organizationId,
                'repository.id': repositoryId,
            })
            .sort({ openedAt: -1, createdAt: -1 })
            .limit(limit)
            .lean()
            .exec();

        return mapSimpleModelsToEntities(docs, PullRequestsEntity);
    }
    //#endregion

    //#region Update
    async update(
        pullRequest: PullRequestsEntity,
        updateData: Omit<Partial<IPullRequests>, 'uuid' | 'id'>,
    ): Promise<PullRequestsEntity | null> {
        // Tenant-scoped: the entity always carries `organizationId`
        // (schema `required: true`), so AND-ing it into the filter
        // closes a defense-in-depth gap without changing the
        // signature for any caller. A stale or swapped entity from
        // another tenant can no longer accidentally write here.
        const filter: Record<string, unknown> = { _id: pullRequest.uuid };
        if (pullRequest.organizationId) {
            filter.organizationId = pullRequest.organizationId;
        }
        const doc = await this.pullRequestsModel.findOneAndUpdate(
            filter,
            { $set: updateData },
            { new: true },
        );
        return doc ? mapSimpleModelToEntity(doc, PullRequestsEntity) : null;
    }

    async updateFile(
        fileId: string,
        updateData: Partial<IFile>,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null> {
        const sanitizedUpdateData =
            this.sanitizeCodeReviewConfigData(updateData);

        const doc = await this.pullRequestsModel
            .findOneAndUpdate(
                {
                    'files.id': fileId,
                    'organizationId': organizationAndTeamData.organizationId,
                },
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
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null> {
        const updateFields = Object.entries(updateData).reduce(
            (acc, [key, value]) => {
                acc[`files.$[file].suggestions.$[suggestion].${key}`] = value;
                return acc;
            },
            {},
        );

        const doc = await this.pullRequestsModel
            .findOneAndUpdate(
                {
                    'files.suggestions.id': suggestionId,
                    'organizationId': organizationAndTeamData.organizationId,
                },
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
    }

    async updateSyncedSuggestionsFlag(
        pullRequestNumbers: number[],
        repositoryId: string,
        organizationId: string,
        synced: boolean,
    ): Promise<void> {
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
    }

    async updateSyncedWithIssuesFlag(
        prNumber: number,
        repositoryId: string,
        organizationId: string,
        synced: boolean,
    ): Promise<void> {
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
    }
    //#endregion
}
