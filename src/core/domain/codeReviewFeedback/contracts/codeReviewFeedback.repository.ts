import { CodeReviewFeedbackEntity } from '../entities/codeReviewFeedback.entity';
import { ICodeReviewFeedback } from '../interfaces/codeReviewFeedback.interface';

export const CODE_REVIEW_FEEDBACK_REPOSITORY_TOKEN = Symbol(
    'CodeReviewFeedbackRepository',
);

export interface ICodeReviewFeedbackRepository {
    bulkCreate(
        feedbacks: Omit<ICodeReviewFeedback, 'uuid'>[],
    ): Promise<CodeReviewFeedbackEntity[]>;
    findById(uuid: string): Promise<CodeReviewFeedbackEntity | null>;
    findOne(
        filter?: Partial<ICodeReviewFeedback>,
    ): Promise<CodeReviewFeedbackEntity | null>;
    find(
        filter?: Partial<ICodeReviewFeedback>,
    ): Promise<CodeReviewFeedbackEntity[]>;
    getNativeCollection(): any;
    findByOrganizationAndSyncedFlag(
        organizationId: string,
        syncedEmbeddedSuggestions: boolean,
    ): Promise<CodeReviewFeedbackEntity[]>;
    updateSyncedSuggestionsFlag(
        organizationId: string,
        syncedEmbeddedSuggestions: boolean,
        suggestionId: string,
    ): Promise<CodeReviewFeedbackEntity | null>;
}
