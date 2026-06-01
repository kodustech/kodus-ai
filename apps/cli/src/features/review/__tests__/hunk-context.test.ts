import { describe, expect, it } from 'vitest';
import {
    convertReviewToHunkContext,
    countHunkAnnotations,
} from '../hunk-context.js';
import type { ReviewResult } from '../../../types/review.js';

const baseResult: ReviewResult = {
    summary: 'two issues across two files',
    filesAnalyzed: 2,
    duration: 42,
    issues: [],
};

describe('convertReviewToHunkContext', () => {
    it('groups issues by file, sorts files alphabetically and annotations by line', () => {
        const result: ReviewResult = {
            ...baseResult,
            issues: [
                {
                    file: 'src/utils.ts',
                    line: 10,
                    severity: 'warning',
                    message: 'extracted helper',
                },
                {
                    file: 'src/auth.ts',
                    line: 42,
                    endLine: 48,
                    severity: 'error',
                    category: 'security_vulnerability',
                    message: 'token logged in plaintext',
                    suggestion: 'redact the JWT before logging',
                    ruleId: 'sec/no-token-log',
                },
                {
                    file: 'src/auth.ts',
                    line: 5,
                    severity: 'info',
                    message: 'consider const',
                },
            ],
        };

        const context = convertReviewToHunkContext(result);

        expect(context.version).toBe(1);
        expect(context.files.map((f) => f.path)).toEqual([
            'src/auth.ts',
            'src/utils.ts',
        ]);
        const auth = context.files[0]!;
        expect(auth.summary).toBe('2 findings');
        expect(auth.annotations.map((a) => a.newRange)).toEqual([
            [5, 5],
            [42, 48],
        ]);
        expect(auth.annotations[1]!.summary).toBe(
            '✖ token logged in plaintext',
        );
        // Single-paragraph rationale so hunk's word-wrap renders it cleanly.
        const rationale = auth.annotations[1]!.rationale!;
        expect(rationale).not.toContain('\n\n');
        expect(rationale).toContain('Fix: redact the JWT before logging.');
        // Attribution sits at the end so the prose reads first and the
        // metadata becomes the closing tag.
        expect(
            rationale.endsWith(
                '— Kody · severity error · security_vulnerability · sec/no-token-log',
            ),
        ).toBe(true);
        expect(auth.annotations[0]!.summary).toBe('ℹ consider const');

        const utils = context.files[1]!;
        expect(utils.summary).toBe('1 finding');
    });

    it('falls back to a single-line range when endLine is missing or invalid', () => {
        const result: ReviewResult = {
            ...baseResult,
            issues: [
                {
                    file: 'a.ts',
                    line: 7,
                    severity: 'info',
                    message: 'tiny note',
                },
                {
                    file: 'a.ts',
                    line: 9,
                    endLine: 4,
                    severity: 'info',
                    message: 'inverted endLine',
                },
            ],
        };

        const context = convertReviewToHunkContext(result);
        expect(context.files[0]!.annotations.map((a) => a.newRange)).toEqual([
            [7, 7],
            [9, 9],
        ]);
    });

    it('drops issues that lack a usable file or line anchor', () => {
        const result: ReviewResult = {
            ...baseResult,
            issues: [
                { file: '', line: 1, severity: 'info', message: 'no file' },
                {
                    file: 'a.ts',
                    line: 0,
                    severity: 'info',
                    message: 'zero line',
                },
                {
                    file: 'a.ts',
                    line: -3,
                    severity: 'info',
                    message: 'negative line',
                },
                {
                    file: 'a.ts',
                    line: 12,
                    severity: 'info',
                    message: 'kept',
                },
            ],
        };

        const context = convertReviewToHunkContext(result);
        expect(context.files).toHaveLength(1);
        expect(context.files[0]!.annotations).toHaveLength(1);
        expect(context.files[0]!.annotations[0]!.newRange).toEqual([12, 12]);
    });

    it('reports zero annotations when every finding is PR-level (no file/line)', () => {
        // Mirrors the API response we saw in the wild: a critical finding
        // about the PR description with no file/line anchor.
        const context = convertReviewToHunkContext({
            ...baseResult,
            summary: 'PR description is missing the issue closing statement',
            issues: [
                {
                    file: '',
                    line: 0,
                    severity: 'critical',
                    message:
                        'The PR description is empty and lacks a required GitHub closing statement.',
                },
            ],
        });

        expect(countHunkAnnotations(context)).toBe(0);
        expect(context.files).toHaveLength(0);
    });

    it('renders a clean-summary headline when there are no findings', () => {
        const context = convertReviewToHunkContext({
            ...baseResult,
            summary: '',
            issues: [],
        });
        expect(context.summary).toBe('Kodus review: no findings.');
        expect(context.files).toHaveLength(0);
    });

    it('builds a severity breakdown headline and preserves the API summary', () => {
        const context = convertReviewToHunkContext({
            ...baseResult,
            summary: 'tightening auth and config',
            issues: [
                { file: 'a.ts', line: 1, severity: 'critical', message: 'x' },
                { file: 'a.ts', line: 2, severity: 'critical', message: 'y' },
                { file: 'a.ts', line: 3, severity: 'warning', message: 'z' },
                { file: 'b.ts', line: 4, severity: 'info', message: 'w' },
            ],
        });

        expect(context.summary).toContain('Kodus review: 4 findings');
        expect(context.summary).toContain('2 critical');
        expect(context.summary).toContain('1 warning');
        expect(context.summary).toContain('1 info');
        expect(context.summary).toContain('tightening auth and config');
    });

    it('uses the first sentence as headline and pushes the rest into rationale body', () => {
        const longMessage =
            'The selectedResult is computed before the hunk viewer check, resulting in dead computation if applyFieldMask mutates the object. ' +
            'Move the computation below the if (useHunkViewer) block to ensure the hunk viewer receives all required fields.';
        const context = convertReviewToHunkContext({
            ...baseResult,
            issues: [
                {
                    file: 'src/cmd.ts',
                    line: 347,
                    endLine: 348,
                    severity: 'error',
                    category: 'bug',
                    message: longMessage,
                },
            ],
        });

        const annotation = context.files[0]!.annotations[0]!;
        expect(annotation.summary).toBe(
            '✖ The selectedResult is computed before the hunk viewer check, resulting in dead computation if applyFieldMask mutates the object.',
        );

        // The rest of the message becomes the lead of the rationale, then a
        // single trailing attribution tag with metadata.
        expect(annotation.rationale).toBe(
            'Move the computation below the if (useHunkViewer) block to ensure the hunk viewer receives all required fields. — Kody · severity error · bug',
        );
        expect(annotation.rationale).not.toContain('\n');
    });

    it('does not split on abbreviations like "e.g." or "i.e."', () => {
        const message =
            'Use a redacting logger, e.g. pino-redact, for credentials.';
        const context = convertReviewToHunkContext({
            ...baseResult,
            issues: [
                {
                    file: 'a.ts',
                    line: 1,
                    severity: 'warning',
                    message,
                },
            ],
        });

        const annotation = context.files[0]!.annotations[0]!;
        expect(annotation.summary).toBe(`⚠ ${message}`);
    });

    it('truncates a long single-sentence headline at a word boundary with ellipsis', () => {
        const message =
            'this is a single very long sentence without any periods that just keeps going and going describing in detail every single thing that could possibly be wrong with the code under review forever and ever amen';
        const context = convertReviewToHunkContext({
            ...baseResult,
            issues: [
                {
                    file: 'a.ts',
                    line: 1,
                    severity: 'info',
                    message,
                },
            ],
        });

        const summary = context.files[0]!.annotations[0]!.summary;
        expect(summary.startsWith('ℹ ')).toBe(true);
        expect(summary.endsWith('…')).toBe(true);
        // glyph + space + capped headline + ellipsis must fit comfortably.
        expect(summary.length).toBeLessThanOrEqual(150);
        // The headline must end on a complete word from the original message
        // (cut on a space boundary), never mid-word.
        const headlineWord = summary
            .replace(/^ℹ\s+/, '')
            .replace(/…$/, '')
            .split(/\s+/)
            .pop()!;
        expect(message.split(/\s+/)).toContain(headlineWord);
    });

    it('embeds suggested fix code into the rationale when present', () => {
        const context = convertReviewToHunkContext({
            ...baseResult,
            issues: [
                {
                    file: 'a.ts',
                    line: 10,
                    endLine: 12,
                    severity: 'error',
                    message: 'mutates argument',
                    fix: {
                        type: 'replace',
                        startLine: 10,
                        endLine: 12,
                        oldCode: 'arr.push(x);',
                        newCode: 'return [...arr, x];',
                    },
                },
            ],
        });

        const rationale = context.files[0]!.annotations[0]!.rationale!;
        expect(rationale).toContain('Suggested replace (lines 10-12):');
        expect(rationale).toContain('return [...arr, x];');
        expect(rationale).not.toContain('\n');
    });
});
