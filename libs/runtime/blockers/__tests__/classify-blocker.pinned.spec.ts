import { classifyBlocker, type BlockerInput, type ClassifiedBlocker } from '../catalog';
import PINNED from './fixtures/classify-blocker.pinned.json';

// The card every blocker gets is shown in Environment Health and keyed by its
// signature (lessons, grouping), so a rule moved above another must not
// reclassify a blocker silently. These outputs were recorded from the
// classifier before it became a rule registry: every input its own specs and
// its callers' specs feed it, plus one input per rule and per branch
// (fixtures/rule-examples.ts). A change here is a change of what users see.

const cases = PINNED as unknown as Array<{ input: BlockerInput; output: ClassifiedBlocker }>;

describe('classifyBlocker pinned outputs', () => {
    it('keeps every recorded blocker card byte for byte', () => {
        const drifted = cases.filter(({ input, output }) => JSON.stringify(classifyBlocker(input)) !== JSON.stringify(output));
        expect(drifted.map((c) => c.input)).toEqual([]);
    });

    it('covers every kind a card can have', () => {
        expect(new Set(cases.map((c) => c.output.kind)).size).toBeGreaterThanOrEqual(13);
    });
});
