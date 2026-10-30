/**
 * Invariants of the context-need classifier prompt (issue #1826).
 *
 * Two sentences here each fixed a measured production failure:
 *   - the prompt used to claim "the reviewer sees the changed lines AND the
 *     complete file they live in", which taught the classifier to answer
 *     `diff-only` for every file-property rule;
 *   - a census over 808 real rules put 67% in `full-file` because the guidance
 *     described a category instead of giving a test (full-file costs -14pp
 *     recall and +85% input tokens when unconditional).
 * And the prompt must stay in step with the domain type: a need added to
 * CONTEXT_NEEDS and not to the prompt can never be produced by the classifier.
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

    it('makes full-file require naming a count, a comparison or an absence', () => {
        for (const word of ['COUNT', 'COMPARISON', 'ABSENCE']) {
            expect(COMPILER_SYSTEM_PROMPT).toContain(word);
        }
        expect(COMPILER_SYSTEM_PROMPT).toContain(
            'If you cannot name which of those three it is, it is not "full-file"',
        );
    });

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
