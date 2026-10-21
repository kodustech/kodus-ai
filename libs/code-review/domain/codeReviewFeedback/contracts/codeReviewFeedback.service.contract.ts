import { ICodeReviewFeedbackRepository } from './codeReviewFeedback.repository';

import { CodeReviewFeedbackEntity } from '../entities/codeReviewFeedback.entity';

export const CODE_REVIEW_FEEDBACK_SERVICE_TOKEN = Symbol(
    'CodeReviewFeedbackService',
);

export interface ICodeReviewFeedbackService extends ICodeReviewFeedbackRepository {
    getByOrganizationId(
        organizationId: string,
    ): Promise<CodeReviewFeedbackEntity[]>;
}
