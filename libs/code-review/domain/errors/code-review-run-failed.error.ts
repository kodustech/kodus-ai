import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';

/** A completed pipeline whose critical outcome cannot safely be called success. */
export class CodeReviewRunFailedError extends Error {
    readonly errorClassification = ErrorClassification.PERMANENT;

    constructor(message: string) {
        super(message);
        this.name = 'CodeReviewRunFailedError';
    }
}
