import { describe, it, expect, vi } from 'vitest';
import { RealReviewApi } from '../api/review.api.js';
import { normalizeSuggestionsResponse } from '../review-normalizer.js';
import { formatReviewOutput } from '../../utils/review-output.js';
import type {
    PullRequestSuggestionsResponse,
    ReviewResult,
} from '../../types/review.js';

const base = { file: 'a.ts', line: 1, message: 'm' };
const apiIssues = ['critical', 'high', 'medium', 'low'].map((severity) => ({
    ...base,
    severity,
}));

function expectAllRendered(markdown: string) {
    expect(markdown).toContain('| 🟣 Critical | 1 |');
    expect(markdown).toContain('| 🔴 Errors | 1 |');
    expect(markdown).toContain('| 🟡 Warnings | 1 |');
    expect(markdown).toContain('| 🔵 Info | 1 |');
    expect(markdown).toContain('CRITICAL: a.ts:1');
    expect(markdown).toContain('ERROR: a.ts:1');
    expect(markdown).toContain('WARNING: a.ts:1');
    expect(markdown).toContain('INFO: a.ts:1');
}

describe('markdown report severities', () => {
    it('`pr suggestions` path renders every API severity', () => {
        const result = normalizeSuggestionsResponse({
            issues: apiIssues,
        } as unknown as PullRequestSuggestionsResponse);
        expectAllRendered(formatReviewOutput(result, 'markdown'));
    });

    it('`review` path (job polling) renders every API severity', async () => {
        const requester = vi
            .fn()
            .mockResolvedValueOnce({ jobId: 'j1', status: 'PENDING' })
            .mockResolvedValueOnce({
                jobId: 'j1',
                status: 'COMPLETED',
                result: {
                    summary: 'Found 4 issues',
                    issues: apiIssues,
                    filesAnalyzed: 1,
                    duration: 1,
                } as unknown as ReviewResult,
            });
        vi.useFakeTimers();
        const api = new RealReviewApi(requester as never);
        const promise = api.analyzeWithMetrics('diff', 'tok');
        await vi.runAllTimersAsync();
        const result = await promise;
        vi.useRealTimers();
        expectAllRendered(formatReviewOutput(result, 'markdown'));
    });
});
