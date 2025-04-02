export const CODE_REVIEW_SERVICE_TOKEN = 'CODE_REVIEW_SERVICE_TOKEN';

export interface ICodeReviewService {
    handlePullRequest(...args): Promise<any>;
}
