/**
 * Invariants of the context-need classifier prompt (issue #1826).
 *
 * This prompt decides, once per rule, what the judge will be shown for the rest
 * of that rule's life. It is prose, so its EFFECT can only be measured by
 * running it over real rules — which is what the census in
 * scripts/analysis/1826-classify-context-need.mjs is for. What a unit test can
 * do is stop the load-bearing sentences from disappearing in an edit, and stop
 * the prompt from drifting out of step with the domain type.
 *
 * Both failures have already happened here:
 *
 *   - the prompt used to assert "the reviewer sees the changed lines AND the
 *     complete file they live in". It was written when every shard carried its
 *     file whole. That stopped being true, the sentence stayed, and it taught
 *     the classifier to answer `diff-only` for the entire "no unused imports /
 *     function too long / missing docstring" family — the exact rules #1826
 *     exists to serve.
 *
 *   - a first census over 808 real library rules put 67% of them in
 *     `full-file`, because the guidance described a category ("a property of a
 *     whole function, class or file") instead of giving a test. Rules like "use
 *     next/image instead of <img>" came back needing the whole file. Since
 *     `full-file` makes every shard haul that file — measured at -14pp recall
 *     and +85.4% input tokens when it was unconditional — over-declaring is not
 *     a harmless default.
 */
import {
    COMPILER_SYSTEM_PROMPT,
    CONTEXT_NEEDS,
} from './kody-rules-detector.compiler';

describe('the context-need classifier prompt', () => {
    it('tells the classifier the judge sees ONLY the changed lines', () => {
        expect(COMPILER_SYSTEM_PROMPT).toContain(
            'The reviewer sees ONLY the changed lines',
        );
        // The retracted claim, in the shape it had. If it comes back, the whole
        // family of file-property rules silently goes back to diff-only.
        expect(COMPILER_SYSTEM_PROMPT).not.toContain(
            'the complete file they live in',
        );
    });

    it('gives a TEST for diff-only rather than a description', () => {
        expect(COMPILER_SYSTEM_PROMPT).toContain(
            'can you point at ONE changed line',
        );
    });

    it('makes full-file require naming a count, a comparison or an absence', () => {
        for (const word of ['COUNT', 'COMPARISON', 'ABSENCE']) {
            expect(COMPILER_SYSTEM_PROMPT).toContain(word);
        }
        expect(COMPILER_SYSTEM_PROMPT).toContain(
            'If you cannot name which of those three it is, it is not "full-file"',
        );
    });

    it('carries the counterexamples the census produced', () => {
        // Real misclassifications from the 808-rule census. They are in the
        // prompt because describing the category was not enough.
        expect(COMPILER_SYSTEM_PROMPT).toContain('NOT full-file');
        expect(COMPILER_SYSTEM_PROMPT).toContain('never expose secrets');
    });

    it('says why over-declaring costs, not just that it is wrong', () => {
        expect(COMPILER_SYSTEM_PROMPT).toContain(
            'haul the whole file',
        );
    });

    it('keeps PR-scope rules on diff-only', () => {
        expect(COMPILER_SYSTEM_PROMPT).toContain('A PR-SCOPE rule');
        expect(COMPILER_SYSTEM_PROMPT).toContain('always "diff-only"');
    });

    // The drift guard. A need added to the domain union and not to the prompt
    // can never be produced by the classifier: the whole feature would be
    // unreachable, silently, and every rule would fall back to diff-only.
    it('offers every need the domain accepts, and no others', () => {
        for (const need of CONTEXT_NEEDS) {
            expect(COMPILER_SYSTEM_PROMPT).toContain(`"${need}"`);
        }
    });

    it('lists every accepted need in the JSON template it asks for', () => {
        const template = COMPILER_SYSTEM_PROMPT.slice(
            COMPILER_SYSTEM_PROMPT.indexOf('Return ONLY JSON'),
        );
        for (const need of CONTEXT_NEEDS) {
            expect(template).toContain(need);
        }
    });
});
