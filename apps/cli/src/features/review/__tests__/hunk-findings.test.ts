import { describe, expect, it } from 'vitest';
import { convertReviewToHunkFindings } from '../hunk-findings.js';
import type { ReviewIssue, ReviewResult } from '../../../types/review.js';

function issue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
    return {
        file: 'src/a.ts',
        line: 12,
        severity: 'warning',
        message: 'Something is off here.',
        ...overrides,
    } as ReviewIssue;
}

function review(issues: ReviewIssue[], summary?: string): ReviewResult {
    return { issues, summary } as ReviewResult;
}

describe('convertReviewToHunkFindings', () => {
    it('normalizes the API severity vocabulary the sidebar cannot render', () => {
        // `/cli/review` skips the suggestions normalizer, so a live review
        // really does hand us `high` / `medium` / `low`.
        const { findings } = convertReviewToHunkFindings(
            review([
                issue({ severity: 'high' as never }),
                issue({ severity: 'medium' as never }),
                issue({ severity: 'low' as never }),
                issue({ severity: 'critical' }),
                issue({ severity: undefined as never }),
            ]),
        );
        expect(findings.map((f) => f.severity)).toEqual([
            'error',
            'warning',
            'info',
            'critical',
            'info',
        ]);
    });

    it('carries severity through as data rather than a glyph', () => {
        const { findings } = convertReviewToHunkFindings(
            review([
                issue({ severity: 'critical' }),
                issue({ severity: 'info' }),
            ]),
        );
        expect(findings.map((f) => f.severity)).toEqual(['critical', 'info']);
    });

    it('defaults endLine to line and preserves an explicit range', () => {
        const { findings } = convertReviewToHunkFindings(
            review([issue({ line: 12 }), issue({ line: 12, endLine: 20 })]),
        );
        expect(findings[0]).toMatchObject({ line: 12, endLine: 12 });
        expect(findings[1]).toMatchObject({ line: 12, endLine: 20 });
    });

    it('clamps an endLine that precedes the start line', () => {
        const { findings } = convertReviewToHunkFindings(
            review([issue({ line: 30, endLine: 5 })]),
        );
        expect(findings[0].endLine).toBe(30);
    });

    it('drops findings with no file or no usable line', () => {
        const { findings } = convertReviewToHunkFindings(
            review([
                issue({ id: 'keep' } as Partial<ReviewIssue>),
                issue({ file: undefined }),
                issue({ line: undefined }),
                issue({ line: 0 }),
                issue({ line: -3 }),
                issue({ line: Number.NaN }),
            ]),
        );
        expect(findings).toHaveLength(1);
    });

    it('falls back through message → suggestion → recommendation for the title', () => {
        const { findings } = convertReviewToHunkFindings(
            review([
                issue({ message: undefined, suggestion: 'Use const.' }),
                issue({
                    message: undefined,
                    suggestion: undefined,
                    recommendation: 'Add a test.',
                }),
                issue({
                    message: undefined,
                    suggestion: undefined,
                    recommendation: undefined,
                }),
            ]),
        );
        expect(findings.map((f) => f.title)).toEqual([
            'Use const.',
            'Add a test.',
            'Kodus finding',
        ]);
    });

    it('collapses whitespace so a title stays one sidebar row', () => {
        const { findings } = convertReviewToHunkFindings(
            review([issue({ message: 'multi\n  line\tmessage' })]),
        );
        expect(findings[0].title).toBe('multi line message');
    });

    it('truncates very long titles', () => {
        const { findings } = convertReviewToHunkFindings(
            review([issue({ message: 'x'.repeat(500) })]),
        );
        expect(findings[0].title).toHaveLength(200);
        expect(findings[0].title.endsWith('…')).toBe(true);
    });

    it('assigns stable ids based on the original issue order', () => {
        const { findings } = convertReviewToHunkFindings(
            review([issue({ file: undefined }), issue(), issue()]),
        );
        expect(findings.map((f) => f.id)).toEqual(['kodus-1', 'kodus-2']);
    });

    it('keeps category and ruleId when present, omits them when blank', () => {
        const { findings } = convertReviewToHunkFindings(
            review([
                issue({ category: 'security', ruleId: 'no-eval' }),
                issue({ category: '', ruleId: '' }),
            ]),
        );
        expect(findings[0]).toMatchObject({
            category: 'security',
            ruleId: 'no-eval',
        });
        expect(findings[1].category).toBeUndefined();
        expect(findings[1].ruleId).toBeUndefined();
    });

    it('handles a review with no issues at all', () => {
        expect(convertReviewToHunkFindings({} as ReviewResult)).toEqual({
            version: 1,
            summary: undefined,
            findings: [],
        });
    });
});
