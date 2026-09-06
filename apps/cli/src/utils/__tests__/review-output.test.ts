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

    it('serializes the stable review telemetry contract without context body data', () => {
        const contextBody = 'private context body';
        const result: ReviewResult = {
            ...REVIEW_RESULT,
            reviewTelemetry: {
                schemaVersion: 1,
                elapsedMs: 25,
                modelCallCount: 1,
                modelCalls: [
                    {
                        callId: 'call-000001',
                        logicalCallId: 'logical-call-000001',
                        attempt: 1,
                        provider: 'anthropic',
                        model: 'anthropic:claude-sonnet',
                        agent: 'bug-agent',
                        phase: 'finder',
                        sdkMaxRetries: 3,
                        status: 'completed',
                        elapsedMs: 20,
                        usage: {
                            inputTokens: 100,
                            outputTokens: 20,
                            cacheReadTokens: 40,
                            cacheWriteTokens: 10,
                        },
                    },
                ],
                usageTotals: {
                    inputTokens: 100,
                    outputTokens: 20,
                    totalTokens: 0,
                    reasoningTokens: 0,
                    cacheReadTokens: 40,
                    cacheWriteTokens: 10,
                    fieldReportingCallCount: {
                        inputTokens: 1,
                        outputTokens: 1,
                        totalTokens: 0,
                        reasoningTokens: 0,
                        cacheReadTokens: 1,
                        cacheWriteTokens: 1,
                    },
                    callsWithUsage: 1,
                    incompleteCallCount: 0,
                    incompleteReasons: [],
                },
                contextReceipts: [
                    {
                        callId: 'call-000001',
                        logicalCallId: 'logical-call-000001',
                        source: 'cli-review-context-file',
                        contentType: 'text/plain; charset=utf-8',
                        sha256: '0123456789abcdef',
                        utf8Bytes: Buffer.byteLength(contextBody, 'utf8'),
                        recipient: 'bug-agent',
                        phase: 'finder',
                        attemptState: 'completed',
                        deliveryState: 'confirmed',
                    },
                ],
            },
        };

        const serialized = formatReviewOutput(result, 'json');

        expect(JSON.parse(serialized)).toEqual(result);
        expect(serialized).not.toContain(contextBody);
    });
});
