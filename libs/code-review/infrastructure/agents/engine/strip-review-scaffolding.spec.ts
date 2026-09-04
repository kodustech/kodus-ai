import {
    looksLikeReviewScaffolding,
    stripReviewScaffolding,
} from './strip-review-scaffolding';

/**
 * The case this exists for, taken verbatim from production.
 *
 * Pull request #1851, 2026-09-04 01:24:10 UTC. The formatter had aborted 13
 * seconds earlier at its 90-second ceiling (`[FORMATTER] Formatting failed:
 * This operation was aborted`, 01:23:57.714), so the batch fell back to raw
 * content and the reviewer's internal scaffolding was posted to the pull
 * request for a customer to read.
 */
const LEAKED = `WHAT: the new dedup marks the job FAILED (handleFailure) BEFORE checking 'already terminal', so any redelivery of the exhausted branch skips notifyReviewFailed forever
WHY: under the new code a single transient notify failure or crash permanently suppresses the customer-facing failure notice
HOW: gate the skip on a persisted 'notified' marker instead of the job status that handleFailure itself just wrote`;

describe('stripReviewScaffolding', () => {
    it('turns the comment that leaked on #1851 into prose', () => {
        const out = stripReviewScaffolding(LEAKED);

        expect(out).not.toMatch(/WHAT:|WHY:|HOW:/);
        // Every part survives — this removes labels, it does not summarise.
        expect(out).toContain('the new dedup marks the job FAILED');
        expect(out).toContain('permanently suppresses the customer-facing');
        expect(out).toContain("gate the skip on a persisted 'notified' marker");
        // One paragraph, not three orphaned fragments.
        expect(out.split('\n')).toHaveLength(1);
    });

    it('handles the single-line form models actually emit', () => {
        // "WHAT: x. WHY: y. HOW: z." on one line. A line-anchored match strips
        // only the first label and ships the other two.
        const out = stripReviewScaffolding('WHAT: x. WHY: y. HOW: z.');

        expect(out).not.toMatch(/WHAT:|WHY:|HOW:/);
        expect(out).toContain('x.');
        expect(out).toContain('y.');
        expect(out).toContain('z.');
    });

    it('does not rewrite a label that lives inside a code fence', () => {
        const src = 'WHAT: the log is wrong\n```ts\nlog("WHY: not a label");\n```';

        expect(stripReviewScaffolding(src)).toContain('WHY: not a label');
    });

    it('leaves prose alone', () => {
        // A suggestion the formatter already handled, or one from a source that
        // never used the template (Kody Rules findings), must pass through
        // untouched. A fallback that rewrites healthy output is worse than none.
        const prose =
            'The migration logs its result with console.log instead of the system logger. Inject PinoLoggerService and call logger.log with a stable context.';

        expect(stripReviewScaffolding(prose)).toBe(prose);
        expect(looksLikeReviewScaffolding(prose)).toBe(false);
    });

    it('handles the labels a model emits with markdown emphasis', () => {
        const out = stripReviewScaffolding(
            '**WHAT:** the guard is missing\n**WHY:** it throws on null',
        );

        expect(out).toBe('the guard is missing. it throws on null.');
    });

    it('handles the numbered form the prompt actually asks for', () => {
        const out = stripReviewScaffolding(
            '1. WHAT: null is passed to processItem\n2. WHY: causes a null dereference\n3. HOW: guard the call',
        );

        expect(out).not.toMatch(/^\s*\d\./);
        expect(out).toContain('null is passed to processItem');
        expect(out).toContain('guard the call');
    });

    it('handles a label on its own line, text below', () => {
        const out = stripReviewScaffolding(
            'WHAT:\nthe collection can be empty\nWHY:\nthe caller dereferences it',
        );

        expect(out).toBe(
            'the collection can be empty. the caller dereferences it.',
        );
    });

    it('fires on WHAT alone, because HOW is optional by design', () => {
        // The prompt says to omit HOW when the fix is speculative, so a
        // two-part leak is as real as a three-part one.
        expect(
            looksLikeReviewScaffolding('WHAT: the ref is undefined'),
        ).toBe(true);
    });

    it('does not swallow a code block between labels', () => {
        const out = stripReviewScaffolding(
            'WHAT: the call is unguarded\nHOW: wrap it\n```ts\nif (x) run();\n```',
        );

        expect(out).toContain('if (x) run();');
    });

    it('keeps sentences separated when the model omitted the full stop', () => {
        const out = stripReviewScaffolding('WHAT: a is null\nWHY: b throws');

        expect(out).toBe('a is null. b throws.');
    });

    it('returns the original rather than emptying a suggestion', () => {
        // Labels with nothing after them: bad output, but blanking the comment
        // would be worse than leaving it as it was.
        const onlyLabels = 'WHAT:\nWHY:\nHOW:';

        expect(stripReviewScaffolding(onlyLabels)).toBe(onlyLabels);
    });

    it('is safe on empty and undefined-ish input', () => {
        expect(stripReviewScaffolding('')).toBe('');
        expect(looksLikeReviewScaffolding('')).toBe(false);
    });
});
