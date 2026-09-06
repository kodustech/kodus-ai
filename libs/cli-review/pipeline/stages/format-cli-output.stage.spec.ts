import type { CliReviewResponse } from '@libs/cli-review/domain/types/cli-review.types';
import {
    REVIEW_CONTEXT_CONTENT_TYPE,
    REVIEW_CONTEXT_SOURCE,
    createReviewContextDelivery,
} from '@libs/cli-review/domain/types/review-context.types';
import { CliInputConverter } from '@libs/cli-review/infrastructure/converters/cli-input.converter';
import type { CliReviewPipelineContext } from '../context/cli-review-pipeline.context';
import {
    FormatCliOutputStage,
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
    it('removes an echoed context body from every model-controlled response string', () => {
        const body = 'CANARY private packet';
        const response: CliReviewResponse = {
            summary: 'Found one issue',
            issues: [
                {
                    file: 'src/index.ts',
                    line: 1,
                    severity: 'critical',
                    category: 'bug',
                    message: `Message ${body}`,
                    suggestion: `Suggestion ${body}`,
                    recommendation: `Recommendation ${body}`,
                    ruleId: 'rule-1',
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
        const value: CliReviewResponse = {
            summary: 'No issues',
            issues: [],
            filesAnalyzed: 1,
            duration: 1,
        };

        expect(redactReviewContextFromResponse(value, undefined)).toBe(value);
    });

    it('redacts partial quoted and whitespace-reflowed context echoes as whole fields', () => {
        const body = [
            'Abort cleanup evidence:',
            'the stream must stop after cancellation',
            'and release its listener.',
        ].join('\n');
        const value: CliReviewResponse = {
            summary: 'Found one issue',
            issues: [
                {
                    file: 'src/index.ts',
                    line: 8,
                    severity: 'high',
                    category: 'bug',
                    message:
                        '> the stream must stop after cancellation   and release its listener',
                    suggestion: 'Unrelated remediation prose.',
                    fixable: false,
                },
            ],
            filesAnalyzed: 1,
            duration: 1,
        };

        const redacted = redactReviewContextFromResponse(value, body);

        expect(redacted.issues[0]?.message).toBe('[review context redacted]');
        expect(redacted.issues[0]?.suggestion).toBe(
            'Unrelated remediation prose.',
        );
    });

    it('does not corrupt legal structural output or unrelated prose for a short context body', () => {
        const value: CliReviewResponse = {
            summary: 'Found one issue in src/index.ts',
            issues: [
                {
                    file: 'src/index.ts',
                    line: 1,
                    severity: 'critical',
                    category: 'security',
                    message: 'Fix the expression before merging.',
                    suggestion: 'Extract the expression.',
                    ruleId: 'rule-src',
                    fixable: false,
                },
            ],
            filesAnalyzed: 1,
            duration: 1,
        };

        expect(redactReviewContextFromResponse(value, 'src')).toEqual(value);
    });

    it('redacts an exact short-body echo only from model-controlled text', () => {
        const value: CliReviewResponse = {
            summary: 'Found one issue in src/index.ts',
            issues: [
                {
                    file: 'src/index.ts',
                    line: 1,
                    severity: 'critical',
                    message: 'src',
                    fixable: false,
                },
            ],
            filesAnalyzed: 1,
            duration: 1,
        };

        const redacted = redactReviewContextFromResponse(value, 'src');

        expect(redacted.issues[0]?.message).toBe('[review context redacted]');
        expect(redacted.issues[0]?.file).toBe('src/index.ts');
        expect(redacted.summary).toBe(value.summary);
    });

    it('runs converter, output redaction, receipt attachment, and persistence-facing response together', async () => {
        const delivery = createReviewContextDelivery(
            reviewContext,
            'kodus-bug-review-agent',
            'finder',
        );
        const stage = new FormatCliOutputStage(new CliInputConverter());
        const context = {
            correlationId: 'correlation-1',
            validSuggestions: [
                {
                    relevantFile: 'src/index.ts',
                    relevantLinesStart: 7,
                    severity: 'high',
                    label: 'bug',
                    suggestionContent: `The model echoed ${reviewContext.body}`,
                    improvedCode: `Quoted: “${reviewContext.body.replaceAll('\n', ' ')}”`,
                },
            ],
            changedFiles: [{}],
            startTime: Date.now(),
            reviewContext,
            reviewContextDeliveries: [delivery],
        } as unknown as CliReviewPipelineContext;

        const result = await stage.execute(context);

        expect(result.cliResponse).toMatchObject({
            issues: [
                {
                    file: 'src/index.ts',
                    severity: 'high',
                    message: '[review context redacted]',
                    suggestion: '[review context redacted]',
                },
            ],
            reviewContextDeliveries: [delivery],
        });
        expect(JSON.stringify(result.cliResponse)).not.toContain(
            reviewContext.body,
        );
    });
});
