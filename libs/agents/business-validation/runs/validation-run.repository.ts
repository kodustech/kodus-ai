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
    createdAt: Date;
}

export type NewValidationRun = Omit<ValidationRunRecord, 'id' | 'createdAt'>;

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

    async findSince(
        organizationId: string,
        since: Date,
        filter: { teamId?: string; repositoryIds?: string[] } = {},
    ): Promise<ValidationRunRecord[]> {
        const docs = await this.model
            .find({
                organizationId,
                createdAt: { $gte: since },
                ...(filter.teamId ? { teamId: filter.teamId } : {}),
                ...(filter.repositoryIds?.length
                    ? { repositoryId: { $in: filter.repositoryIds } }
                    : {}),
            })
            .sort({ createdAt: -1 })
            .limit(5000)
            .lean()
            .exec();
        return docs.map(toRecord);
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
                    createdAt: {
                        $gte: window.notBefore,
                        $lte: window.notAfter,
                    },
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
