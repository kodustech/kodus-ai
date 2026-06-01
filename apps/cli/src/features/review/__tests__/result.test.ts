import { describe, expect, it } from 'vitest';
import {
    formatFailOnExitMessage,
    formatTrialCompletionMessage,
    isHunkPlatformSupported,
    shouldFailReview,
    shouldUseHunkViewer,
    shouldUseInteractiveReview,
} from '../result.js';
import type { ReviewResult, TrialReviewResult } from '../../../types/review.js';

describe('review result helpers', () => {
    it('uses interactive mode only for terminal human flows', () => {
        expect(
            shouldUseInteractiveReview({
                isAgent: false,
                interactive: true,
                output: undefined,
                format: 'terminal',
            }),
        ).toBe(true);
        expect(
            shouldUseInteractiveReview({
                isAgent: false,
                interactive: false,
                output: undefined,
                format: 'terminal',
            }),
        ).toBe(true);
        expect(
            shouldUseInteractiveReview({
                isAgent: true,
                interactive: true,
                output: undefined,
                format: 'terminal',
            }),
        ).toBe(false);
        expect(
            shouldUseInteractiveReview({
                isAgent: false,
                interactive: false,
                output: '/tmp/out.txt',
                format: 'terminal',
            }),
        ).toBe(false);
    });

    it('detects blocking issues based on fail-on severity', () => {
        const result: ReviewResult = {
            summary: 'Issues',
            issues: [
                {
                    file: 'src/a.ts',
                    line: 1,
                    severity: 'warning',
                    message: 'warn',
                },
                {
                    file: 'src/b.ts',
                    line: 2,
                    severity: 'error',
                    message: 'error',
                },
            ],
            filesAnalyzed: 2,
            duration: 1,
        };

        expect(shouldFailReview(result, 'warning')).toBe(true);
        expect(shouldFailReview(result, 'error')).toBe(true);
        expect(shouldFailReview(result, 'critical')).toBe(false);
        expect(shouldFailReview(result, undefined)).toBe(false);
        expect(formatFailOnExitMessage(result, 'error')).toBe(
            'Exiting with code 1 because 1 issue meets or exceeds `--fail-on error`.',
        );
        expect(formatFailOnExitMessage(result, 'warning')).toBe(
            'Exiting with code 1 because 2 issues meet or exceed `--fail-on warning`.',
        );
        expect(formatFailOnExitMessage(result, 'critical')).toBeNull();
    });

    it('routes to hunk viewer only for fully interactive humans on supported scopes and platforms', () => {
        const baseline = {
            isAgent: false,
            interactive: undefined,
            noHunk: false,
            output: undefined,
            format: 'terminal',
            ttyOut: true,
            scopeSupported: true,
            platformSupported: true,
        } as const;

        expect(shouldUseHunkViewer(baseline)).toBe(true);
        expect(shouldUseHunkViewer({ ...baseline, isAgent: true })).toBe(false);
        expect(shouldUseHunkViewer({ ...baseline, noHunk: true })).toBe(false);
        expect(shouldUseHunkViewer({ ...baseline, interactive: true })).toBe(
            false,
        );
        expect(
            shouldUseHunkViewer({ ...baseline, output: '/tmp/out.json' }),
        ).toBe(false);
        expect(shouldUseHunkViewer({ ...baseline, format: 'json' })).toBe(
            false,
        );
        expect(shouldUseHunkViewer({ ...baseline, ttyOut: false })).toBe(false);
        expect(
            shouldUseHunkViewer({ ...baseline, scopeSupported: false }),
        ).toBe(false);
        expect(
            shouldUseHunkViewer({ ...baseline, platformSupported: false }),
        ).toBe(false);
    });

    it('treats Windows as an unsupported hunk platform', () => {
        // hunkdiff currently ships prebuilt binaries for darwin/linux only.
        expect(isHunkPlatformSupported('win32')).toBe(false);
        expect(isHunkPlatformSupported('darwin')).toBe(true);
        expect(isHunkPlatformSupported('linux')).toBe(true);
    });

    it('formats trial completion message from trial info or rate limit', () => {
        const trialInfoResult: TrialReviewResult = {
            summary: 'ok',
            issues: [],
            filesAnalyzed: 1,
            duration: 1,
            trialInfo: {
                reviewsUsed: 1,
                reviewsLimit: 5,
                resetsAt: 'tomorrow',
            },
        };
        const rateLimitResult: TrialReviewResult = {
            summary: 'ok',
            issues: [],
            filesAnalyzed: 1,
            duration: 1,
            rateLimit: {
                remaining: 3,
                limit: 5,
            },
        };

        expect(formatTrialCompletionMessage(trialInfoResult)).toBe(
            'Review complete! (Trial: 1/5 reviews today)',
        );
        expect(formatTrialCompletionMessage(rateLimitResult)).toBe(
            'Review complete! (Trial: 2/5 reviews today)',
        );
    });
});
