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
