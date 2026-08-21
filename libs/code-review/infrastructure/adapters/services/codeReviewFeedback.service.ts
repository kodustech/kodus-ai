import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Collection } from 'mongoose';

import { CODE_REVIEW_FEEDBACK_REPOSITORY_TOKEN } from '@libs/code-review/domain/codeReviewFeedback/contracts/codeReviewFeedback.repository';
import { ICodeReviewFeedbackRepository } from '@libs/code-review/domain/codeReviewFeedback/contracts/codeReviewFeedback.repository';
import { ICodeReviewFeedbackService } from '@libs/code-review/domain/codeReviewFeedback/contracts/codeReviewFeedback.service.contract';
import { CodeReviewFeedbackEntity } from '@libs/code-review/domain/codeReviewFeedback/entities/codeReviewFeedback.entity';
import {
    ICodeReviewFeedback,
    ICollectedReaction,
} from '@libs/code-review/domain/codeReviewFeedback/interfaces/codeReviewFeedback.interface';
import {
    IPullRequests,
    IRepository,
} from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

@Injectable()
export class CodeReviewFeedbackService implements ICodeReviewFeedbackService {
    constructor(
        @Inject(CODE_REVIEW_FEEDBACK_REPOSITORY_TOKEN)
        private readonly codeReviewFeedbackRepository: ICodeReviewFeedbackRepository,
    ) {}

    async bulkCreate(
        feedbacks: Omit<ICodeReviewFeedback, 'uuid'>[],
    ): Promise<CodeReviewFeedbackEntity[]> {
        return this.codeReviewFeedbackRepository.bulkCreate(feedbacks);
    }

    bulkUpsertReactions(reactions: ICollectedReaction[]): Promise<number> {
        return this.codeReviewFeedbackRepository.bulkUpsertReactions(reactions);
    }

    findById(uuid: string): Promise<CodeReviewFeedbackEntity | null> {
        return this.codeReviewFeedbackRepository.findById(uuid);
    }

    findOne(
        filter: Partial<ICodeReviewFeedback>,
    ): Promise<CodeReviewFeedbackEntity | null> {
        return this.codeReviewFeedbackRepository.findOne(filter);
    }

    find(
        filter: Partial<ICodeReviewFeedback>,
    ): Promise<CodeReviewFeedbackEntity[]> {
        return this.codeReviewFeedbackRepository.find(filter);
    }

    findByOrganizationAndSyncedFlag(
        organizationId: string,
        repositoryId: string,
        syncedEmbeddedSuggestions: boolean,
    ): Promise<CodeReviewFeedbackEntity[]> {
        return this.codeReviewFeedbackRepository.findByOrganizationAndSyncedFlag(
            organizationId,
            repositoryId,
            syncedEmbeddedSuggestions,
        );
    }

    getByOrganizationId(
        organizationId: string,
    ): Promise<CodeReviewFeedbackEntity[]> {
        return this.codeReviewFeedbackRepository.find({ organizationId });
    }

    getNativeCollection(): Promise<Collection> {
        return this.codeReviewFeedbackRepository.getNativeCollection();
    }

    async bulkCreateTransformed(
        organizationAndTeamData: OrganizationAndTeamData,
        comments: {
            id: number;
            pullRequestReviewId?: string;
            suggestionId: string;
        }[],
        pullRequest: Pick<IPullRequests, 'uuid' | 'number'>,
        repository: Pick<IRepository, 'id' | 'fullName'>,
    ): Promise<CodeReviewFeedbackEntity[]> {
        const codeReviewFeedbacks = comments.map((comment) => ({
            comment: {
                id: comment.id,
                pullRequestReviewId: comment?.pullRequestReviewId,
            },
            suggestionId: comment.suggestionId,
            pullRequest: {
                id: pullRequest.uuid,
                number: pullRequest.number,
                repository: {
                    id: repository.id,
                    fullName: repository.fullName,
                },
            },
            organizationId: organizationAndTeamData.organizationId,
            reactions: { thumbsUp: 0, thumbsDown: 0 },
            syncedEmbeddedSuggestions: false,
        }));

        return this.bulkCreate(codeReviewFeedbacks);
    }

    async updateSyncedSuggestionsFlag(
        organizationId: string,
        suggestionIds: string[],
        syncedEmbeddedSuggestions: boolean,
    ): Promise<void> {
        return this.codeReviewFeedbackRepository.updateSyncedSuggestionsFlag(
            organizationId,
            suggestionIds,
            syncedEmbeddedSuggestions,
        );
    }
}
