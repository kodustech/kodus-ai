import { Injectable } from '@nestjs/common';
import { CODE_REVIEW_FEEDBACK_REPOSITORY_TOKEN } from '@/core/domain/codeReviewFeedback/contracts/codeReviewFeedback.repository';
import { ICodeReviewFeedbackRepository } from '@/core/domain/codeReviewFeedback/contracts/codeReviewFeedback.repository';
import { ICodeReviewFeedbackService } from '@/core/domain/codeReviewFeedback/contracts/codeReviewFeedback.service.contract';
import { Inject } from '@nestjs/common';
import { CodeReviewFeedbackEntity } from '@/core/domain/codeReviewFeedback/entities/codeReviewFeedback.entity';
import { ICodeReviewFeedback } from '@/core/domain/codeReviewFeedback/interfaces/codeReviewFeedback.interface';
import { Collection } from 'mongoose';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    IPullRequests,
    IRepository,
} from '@/core/domain/pullRequests/interfaces/pullRequests.interface';

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
        syncedEmbeddedSuggestions: boolean,
    ): Promise<CodeReviewFeedbackEntity[]> {
        return this.codeReviewFeedbackRepository.findByOrganizationAndSyncedFlag(
            organizationId,
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
        syncedEmbeddedSuggestions: boolean,
        suggestionId: string,
    ): Promise<CodeReviewFeedbackEntity | null> {
        return this.codeReviewFeedbackRepository.updateSyncedSuggestionsFlag(
            organizationId,
            syncedEmbeddedSuggestions,
            suggestionId,
        );
    }
}
