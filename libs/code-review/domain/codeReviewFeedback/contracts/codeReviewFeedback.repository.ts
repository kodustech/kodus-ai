import { CodeReviewFeedbackEntity } from '../entities/codeReviewFeedback.entity';
import {
    ICodeReviewFeedback,
    ICollectedReaction,
} from '../interfaces/codeReviewFeedback.interface';

export const CODE_REVIEW_FEEDBACK_REPOSITORY_TOKEN = Symbol(
    'CodeReviewFeedbackRepository',
);

export interface ICodeReviewFeedbackRepository {
    bulkCreate(
        feedbacks: Omit<ICodeReviewFeedback, 'uuid'>[],
    ): Promise<CodeReviewFeedbackEntity[]>;
    /**
     * Inserts reactions never seen before and refreshes the counts of the ones
     * already stored, keyed by (organizationId, suggestionId). Reaction counts
     * are absolute values read from the provider, so replaying the same input
     * is a no-op.
     */
    bulkUpsertReactions(reactions: ICollectedReaction[]): Promise<number>;
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
        repositoryId: string,
        syncedEmbeddedSuggestions: boolean,
    ): Promise<CodeReviewFeedbackEntity[]>;
    updateSyncedSuggestionsFlag(
        organizationId: string,
        suggestionIds: string[],
        syncedEmbeddedSuggestions: boolean,
    ): Promise<void>;
}
