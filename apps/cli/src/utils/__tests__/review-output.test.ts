import { describe, expect, it } from 'vitest';
import { formatReviewOutput } from '../review-output.js';
import type { ReviewResult } from '../../types/review.js';

const REVIEW_RESULT: ReviewResult = {
    summary: 'Looks good',
    issues: [],
    filesAnalyzed: 1,
    duration: 10,
};

describe('formatReviewOutput', () => {
    it('formats review results for each supported output format', () => {
        expect(formatReviewOutput(REVIEW_RESULT, 'json')).toContain(
            '"summary": "Looks good"',
        );
        expect(formatReviewOutput(REVIEW_RESULT, 'markdown')).toContain(
            '# Code Review Report',
        );
        expect(formatReviewOutput(REVIEW_RESULT, 'prompt')).toContain(
            'REVIEW_ANALYSIS_COMPLETE',
        );
        expect(formatReviewOutput(REVIEW_RESULT, 'terminal')).toContain(
            'Looks good',
        );
    });
});
