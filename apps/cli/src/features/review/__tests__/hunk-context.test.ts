import { describe, expect, it } from 'vitest';
import {
    convertReviewToHunkContext,
    extractMarkdownLinks,
    wrapCodeBlock,
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

        // The body carries the *whole* message, not just the part the summary
        // left over: the summary is a capped label, so anything it drops has to
        // survive here.
        expect(annotation.rationale).toBe(
            `${longMessage} — Kody · severity error · bug`,
        );
        expect(annotation.rationale).not.toContain('\n');
    });

    it('never loses message text to the summary cap', () => {
        // Regression: a first sentence longer than the 140-char cap used to be
        // truncated into the summary with its tail dropped everywhere else.
        const tail = 'THE-TAIL-THAT-MUST-SURVIVE';
        const message = `${'word '.repeat(40)}${tail}. Second sentence.`;
        const context = convertReviewToHunkContext({
            ...baseResult,
            issues: [
                {
                    file: 'src/cmd.ts',
                    line: 10,
                    severity: 'critical',
                    message,
                },
            ],
        });

        const annotation = context.files[0]!.annotations[0]!;
        expect(annotation.summary).toContain('…');
        expect(annotation.summary).not.toContain(tail);
        expect(annotation.rationale).toContain(tail);
        expect(annotation.markup).toContain(tail);
    });

    it('builds an STML body that separates prose from suggested code', () => {
        const context = convertReviewToHunkContext({
            ...baseResult,
            issues: [
                {
                    file: 'src/cmd.ts',
                    line: 10,
                    severity: 'high' as never,
                    category: 'bug',
                    message: 'Resolve it against the cwd.',
                    suggestion: 'const dir = resolve(cwd(), common);',
                },
            ],
        });

        const markup = context.files[0]!.annotations[0]!.markup!;
        // `high` must be normalized before it reaches a severity lookup.
        expect(markup).toContain('<badge color="danger">error</badge>');
        expect(markup).toContain('<p>Resolve it against the cwd.</p>');
        expect(markup).toContain('<h3>Fix</h3>');
        expect(markup).toContain('<code>');
        expect(markup).toContain('const dir = resolve(cwd(), common);');
    });

    it('escapes markup-significant characters in findings', () => {
        const context = convertReviewToHunkContext({
            ...baseResult,
            issues: [
                {
                    file: 'src/cmd.ts',
                    line: 10,
                    severity: 'error',
                    message: 'Use <T> & handle A<B> properly.',
                },
            ],
        });

        const markup = context.files[0]!.annotations[0]!.markup!;
        expect(markup).toContain('&lt;T> &amp; handle A&lt;B>');
        expect(markup).not.toContain('<T>');
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

describe('wrapCodeBlock', () => {
    // STML `code` blocks clip rather than wrap, so an over-long line would be
    // silently truncated — the exact failure this rework exists to remove.
    const long =
        'hunkdiff@0.18.0-beta.0(@opentui/core@0.4.x(...))(@opentui/react@0.4.x(...))(...):';

    it('never drops characters, at any width', () => {
        for (const width of [20, 40, 52, 92]) {
            const wrapped = wrapCodeBlock(long, width);
            expect(wrapped.replace(/\n\s*/g, '')).toBe(long);
        }
    });

    it('keeps every emitted line within the budget', () => {
        for (const line of wrapCodeBlock(long, 40).split('\n')) {
            expect(line.length).toBeLessThanOrEqual(40);
        }
    });

    it('leaves lines that already fit untouched', () => {
        const code = 'const a = 1;\n  return a;';
        expect(wrapCodeBlock(code, 80)).toBe(code);
    });

    it('indents continuations so a wrap still reads as one line', () => {
        const wrapped = wrapCodeBlock('    ' + 'x'.repeat(60), 20);
        expect(wrapped.split('\n').length).toBeGreaterThan(1);
        expect(wrapped.split('\n')[1].startsWith('      ')).toBe(true);
    });
});

describe('extractMarkdownLinks', () => {
    // Kody-rule findings arrive as `... [rule name](https://app.kodus.io/...)`,
    // which used to wrap a 100-char URL through the middle of a sentence.
    const message =
        'Kody rule violation: [Tratamento adequado de exce\u00e7\u00f5es\\.](https://app.kodus.io/settings/code-review/1/kody-rules/abc?teamId=xyz)';

    it('replaces a link with its label and returns the url', () => {
        const { text, links } = extractMarkdownLinks(message);
        expect(text).toBe(
            'Kody rule violation: Tratamento adequado de exce\u00e7\u00f5es.',
        );
        expect(links).toEqual([
            {
                label: 'Tratamento adequado de exce\u00e7\u00f5es.',
                url: 'https://app.kodus.io/settings/code-review/1/kody-rules/abc?teamId=xyz',
            },
        ]);
    });

    it('undoes markdown escaping', () => {
        expect(
            extractMarkdownLinks('exce\u00e7\u00f5es\\. e \\*isto\\*').text,
        ).toBe('exce\u00e7\u00f5es. e *isto*');
    });

    it('leaves text without links untouched', () => {
        expect(extractMarkdownLinks('plain text').text).toBe('plain text');
        expect(extractMarkdownLinks('plain text').links).toEqual([]);
    });

    it('collects every link in the message', () => {
        const { links } = extractMarkdownLinks(
            '[a](https://x.test/1) and [b](https://x.test/2)',
        );
        expect(links.map((l) => l.url)).toEqual([
            'https://x.test/1',
            'https://x.test/2',
        ]);
    });

    it('keeps the url in the rendered note rather than dropping it', () => {
        // STML's `<a>` renders the label and discards the href, so the url has
        // to survive as text somewhere in the body.
        const context = convertReviewToHunkContext({
            ...baseResult,
            issues: [
                {
                    file: 'src/cmd.ts',
                    line: 10,
                    severity: 'critical',
                    ruleId: '43b72fcc-14b5-4917-8b5f-91708a808f88',
                    message,
                },
            ],
        });

        const annotation = context.files[0]!.annotations[0]!;
        expect(annotation.markup).toContain(
            'https://app.kodus.io/settings/code-review/1/kody-rules/abc',
        );
        expect(annotation.markup).not.toContain('](');
        // A raw UUID rule id is noise next to the link, so it is dropped.
        expect(annotation.markup).not.toContain(
            '43b72fcc-14b5-4917-8b5f-91708a808f88',
        );
    });
});
