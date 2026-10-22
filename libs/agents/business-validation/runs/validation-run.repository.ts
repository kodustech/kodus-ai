import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { createLogger } from '@libs/core/log/logger';

import {
    BusinessValidationRunModel,
    type RunAuthor,
    type RunComment,
    type RunReference,
    type RunTask,
} from './validation-run.model';

export interface ValidationRunRecord {
    id: string;
    organizationId: string;
    teamId?: string;
    repositoryId?: string;
    repositoryName?: string;
    pullRequestNumber?: number;
    platformType?: string;
    door: string;
    trigger?: string;
    headSha?: string;
    outcome: string;
    skipReason?: string;
    passed?: boolean;
    references: RunReference[];
    attempts: Array<{
        reference: string;
        tracker: string;
        status: string;
        message?: string;
    }>;
    trackers: string[];
    tasks: RunTask[];
    unseenFiles: string[];
    author?: RunAuthor;
    comment?: RunComment;
    checkRunId?: string;
    pendingRecheck?: boolean;
    pendingSince?: Date;
    /** The author the PR's earliest run named, on a run read per PR. */
    firstAuthor?: RunAuthor;
    createdAt: Date;
}

export type NewValidationRun = Omit<ValidationRunRecord, 'id' | 'createdAt'>;

export interface RunFilter {
    teamId?: string;
    repositoryIds?: string[];
    /** The repository the Cockpit's picker chose, as `owner/name` or `name`. */
    repositoryName?: string;
}

function scope(organizationId: string, filter: RunFilter) {
    const name = filter.repositoryName?.split('/').pop();
    return {
        organizationId,
        ...(filter.teamId ? { teamId: filter.teamId } : {}),
        ...(filter.repositoryIds?.length
            ? { repositoryId: { $in: filter.repositoryIds } }
            : {}),
        ...(name
            ? {
                  repositoryName: {
                      $in: [...new Set([filter.repositoryName, name])],
                  },
              }
            : {}),
    };
}

/** Reads and writes business-logic validation runs. Writes never fail a review. */
@Injectable()
export class ValidationRunRepository {
    private readonly logger = createLogger(ValidationRunRepository.name);

    constructor(
        @InjectModel(BusinessValidationRunModel.name)
        private readonly model: Model<BusinessValidationRunModel>,
    ) {}

    async create(run: NewValidationRun): Promise<string | undefined> {
        try {
            const [doc] = await this.model.insertMany([run]);
            return doc ? String(doc._id) : undefined;
        } catch (error) {
            this.logger.warn({
                message: 'Could not record the business validation run',
                context: ValidationRunRepository.name,
                error,
                metadata: {
                    organizationId: run.organizationId,
                    pullRequest: run.pullRequestNumber,
                },
            });
            return undefined;
        }
    }

    async update(
        id: string,
        patch: Partial<
            Pick<
                ValidationRunRecord,
                'comment' | 'checkRunId' | 'tasks' | 'passed' | 'pendingRecheck'
            >
        >,
    ): Promise<void> {
        try {
            await this.model.updateOne({ _id: id }, { $set: patch }).exec();
        } catch (error) {
            this.logger.warn({
                message: 'Could not update the business validation run',
                context: ValidationRunRepository.name,
                error,
                metadata: { id },
            });
        }
    }

    /** The PR's last run that wrote a comment or a verdict: the one a re-check or a reply builds on. */
    async latestForPullRequest(params: {
        organizationId: string;
        repositoryId: string;
        pullRequestNumber: number;
        withComment?: boolean;
        outcome?: string;
    }): Promise<ValidationRunRecord | undefined> {
        const doc = await this.model
            .findOne({
                organizationId: params.organizationId,
                repositoryId: params.repositoryId,
                pullRequestNumber: params.pullRequestNumber,
                ...(params.withComment ? { comment: { $exists: true } } : {}),
                ...(params.outcome ? { outcome: params.outcome } : {}),
            })
            .sort({ createdAt: -1 })
            .lean()
            .exec();
        return doc ? toRecord(doc) : undefined;
    }

    async forPullRequest(params: {
        organizationId: string;
        repositoryId: string;
        pullRequestNumber: number;
    }): Promise<ValidationRunRecord[]> {
        const docs = await this.model
            .find(params)
            .sort({ createdAt: -1 })
            .limit(50)
            .lean()
            .exec();
        return docs.map(toRecord);
    }

    /**
     * The newest run of each pull request in a range, grouped in Mongo: what
     * the card and the Cockpit count, one document per PR however many runs
     * it had. Each carries `firstAuthor`, the author its earliest run named.
     */
    async latestPerPullRequest(
        organizationId: string,
        range: { from: Date; to?: Date },
        filter: RunFilter = {},
    ): Promise<ValidationRunRecord[]> {
        const docs = await this.model
            .aggregate([
                {
                    $match: {
                        ...scope(organizationId, filter),
                        createdAt: {
                            $gte: range.from,
                            ...(range.to ? { $lte: range.to } : {}),
                        },
                        repositoryId: { $exists: true, $ne: null },
                        pullRequestNumber: { $exists: true, $ne: null },
                    },
                },
                { $sort: { createdAt: -1 } },
                {
                    $group: {
                        _id: {
                            repositoryId: '$repositoryId',
                            pullRequestNumber: '$pullRequestNumber',
                        },
                        latest: { $first: '$$ROOT' },
                        authors: {
                            $push: { $ifNull: ['$author', '$$REMOVE'] },
                        },
                    },
                },
                {
                    $replaceRoot: {
                        newRoot: {
                            $mergeObjects: [
                                '$latest',
                                {
                                    firstAuthor: {
                                        $arrayElemAt: ['$authors', -1],
                                    },
                                },
                            ],
                        },
                    },
                },
                { $sort: { createdAt: -1 } },
            ])
            .allowDiskUse(true)
            .exec();
        return docs.map(toRecord);
    }

    /**
     * The few runs the card reads besides each PR's newest: the last task
     * read, the last run the tracker failed and the last it answered, the
     * first failure since, and the last issue read. With the newest per PR,
     * they are all `summarizeStatus` needs.
     */
    async statusSignals(
        organizationId: string,
        since: Date,
        filter: RunFilter = {},
    ): Promise<ValidationRunRecord[]> {
        const base = {
            ...scope(organizationId, filter),
            createdAt: { $gte: since },
        };
        const newest = (query: Record<string, unknown>, limit = 1) =>
            this.model
                .find({ ...base, ...query })
                .sort({ createdAt: -1 })
                .limit(limit)
                .lean()
                .exec();
        const unavailable = {
            outcome: 'skipped',
            skipReason: 'tracker_unavailable',
        };
        const [read, failed, answered, issues] = await Promise.all([
            newest({ 'tasks.0': { $exists: true } }),
            newest(unavailable),
            newest({
                $or: [
                    { outcome: { $ne: 'skipped' } },
                    {
                        skipReason: { $ne: 'tracker_unavailable' },
                        attempts: { $elemMatch: { status: { $ne: 'error' } } },
                    },
                ],
            }),
            newest(
                {
                    'references.kind': 'git_issue',
                    'attempts.status': 'found',
                },
                20,
            ),
        ]);
        const lastAnswered = (answered[0] as { createdAt?: Date } | undefined)
            ?.createdAt;
        const firstFailure = await this.model
            .find({
                ...base,
                ...unavailable,
                ...(lastAnswered
                    ? { createdAt: { $gte: since, $gt: lastAnswered } }
                    : {}),
            })
            .sort({ createdAt: 1 })
            .limit(1)
            .lean()
            .exec();
        return [
            ...read,
            ...failed,
            ...answered,
            ...issues,
            ...firstFailure,
        ].map(toRecord);
    }

    /**
     * Takes one run skipped because a tracker was down (UC-22), so only one
     * worker re-checks it. Runs too fresh to retry, or too old to matter,
     * stay where they are.
     */
    async claimPendingRecheck(window: {
        notBefore: Date;
        notAfter: Date;
    }): Promise<ValidationRunRecord | undefined> {
        const doc = await this.model
            .findOneAndUpdate(
                {
                    pendingRecheck: true,
                    createdAt: { $lte: window.notAfter },
                    // Counted from the first skip; runs recorded before
                    // `pendingSince` count from their own creation.
                    $or: [
                        { pendingSince: { $gte: window.notBefore } },
                        {
                            pendingSince: { $exists: false },
                            createdAt: { $gte: window.notBefore },
                        },
                    ],
                },
                { $set: { pendingRecheck: false } },
                { sort: { createdAt: 1 }, new: true },
            )
            .lean()
            .exec();
        return doc ? toRecord(doc) : undefined;
    }

    async clearPendingRecheck(params: {
        organizationId: string;
        repositoryId?: string;
        pullRequestNumber?: number;
    }): Promise<void> {
        await this.model
            .updateMany(
                { ...params, pendingRecheck: true },
                { $set: { pendingRecheck: false } },
            )
            .exec()
            .catch(() => undefined);
    }
}

function toRecord(doc: any): ValidationRunRecord {
    const { _id, __v, updatedAt: _updatedAt, ...rest } = doc;
    return { ...rest, id: String(_id) } as ValidationRunRecord;
}
