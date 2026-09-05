import type { CliReviewResponse } from '@libs/cli-review/domain/types/cli-review.types';
import {
    REVIEW_CONTEXT_CONTENT_TYPE,
    REVIEW_CONTEXT_SOURCE,
    createReviewContextDelivery,
} from '@libs/cli-review/domain/types/review-context.types';
import {
    redactReviewContextFromResponse,
    withReviewContextDeliveries,
} from './format-cli-output.stage';

const response: CliReviewResponse = {
    summary: 'No issues',
    issues: [],
    filesAnalyzed: 1,
    duration: 10,
};

const reviewContext = {
    source: REVIEW_CONTEXT_SOURCE,
    contentType: REVIEW_CONTEXT_CONTENT_TYPE,
    body: 'CANARY: inspect cleanup',
};

describe('withReviewContextDeliveries', () => {
    it('adds body-free delivery evidence to the public CLI response', () => {
        const delivery = createReviewContextDelivery(
            reviewContext,
            'kodus-bug-review-agent',
            'finder',
        );

        const result = withReviewContextDeliveries(response, [delivery]);

        expect(result.reviewContextDeliveries).toEqual([delivery]);
        expect(JSON.stringify(result)).not.toContain(reviewContext.body);
    });

    it('returns the unchanged response when delivery evidence is absent', () => {
        expect(withReviewContextDeliveries(response, undefined)).toBe(response);
        expect(withReviewContextDeliveries(response, [])).toBe(response);
    });
});

describe('redactReviewContextFromResponse', () => {
    it('removes an echoed context body from every durable response string', () => {
        const body = 'CANARY private packet';
        const response: CliReviewResponse = {
            summary: `Summary ${body}`,
            issues: [
                {
                    file: `src/${body}.ts`,
                    line: 1,
                    severity: `critical ${body}`,
                    category: `bug ${body}`,
                    message: `Message ${body}`,
                    suggestion: `Suggestion ${body}`,
                    recommendation: `Recommendation ${body}`,
                    ruleId: `rule-${body}`,
                    fixable: true,
                    fix: {
                        range: { start: 1, end: 1 },
                        replacement: `Replacement ${body}`,
                    },
                },
            ],
            filesAnalyzed: 1,
            duration: 1,
        };

        const redacted = redactReviewContextFromResponse(response, body);

        expect(JSON.stringify(redacted)).not.toContain(body);
        expect(redacted.issues[0]?.line).toBe(1);
        expect(redacted.issues[0]?.fix?.range).toEqual({ start: 1, end: 1 });
    });

    it('returns the original response when there is no review context', () => {
        const response: CliReviewResponse = {
            summary: 'No issues',
            issues: [],
            filesAnalyzed: 1,
            duration: 1,
        };

        expect(redactReviewContextFromResponse(response, undefined)).toBe(
            response,
        );
    });
});
