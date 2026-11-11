import type { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import {
    mergeKodyRuleFindings,
    otherLocationsToRender,
} from './kody-rules-merge';

describe('otherLocationsToRender', () => {
    it("leaves out the comment's own range", () => {
        expect(
            otherLocationsToRender({
                relevantFile: 'src/ledger/post.ts',
                relevantLinesStart: 10,
                relevantLinesEnd: 12,
                alsoFoundIn: [
                    'src/ledger/post.ts:10-12',
                    'src/ledger/void.ts:4-4',
                ],
            }),
        ).toEqual(['src/ledger/void.ts:4-4']);
    });

    it('matches the Kody Rules form of an unknown line', () => {
        expect(
            otherLocationsToRender({
                relevantFile: 'src/ledger/post.ts',
                kodyRuleOtherLocations: ['src/ledger/post.ts:?-?', 'b.ts:1-2'],
            }),
        ).toEqual(['b.ts:1-2']);
    });

    it('drops an unresolved location on another file instead of rendering ?-?', () => {
        expect(
            otherLocationsToRender({
                relevantFile: 'src/ledger/post.ts',
                relevantLinesStart: 10,
                relevantLinesEnd: 12,
                kodyRuleOtherLocations: ['src/ledger/void.ts:?-?', 'b.ts:1-2'],
            }),
        ).toEqual(['b.ts:1-2']);
    });

    it('recognises a start-only range as the comment itself', () => {
        expect(
            otherLocationsToRender({
                relevantFile: 'a.ts',
                relevantLinesStart: 7,
                kodyRuleOtherLocations: ['a.ts:7-7', 'b.ts:1-2'],
            }),
        ).toEqual(['b.ts:1-2']);
    });

    it('merges both lists once each', () => {
        expect(
            otherLocationsToRender({
                relevantFile: 'a.ts',
                relevantLinesStart: 1,
                relevantLinesEnd: 1,
                alsoFoundIn: ['b.ts:2-2'],
                kodyRuleOtherLocations: ['b.ts:2-2', 'c.ts:3-3'],
            }),
        ).toEqual(['b.ts:2-2', 'c.ts:3-3']);
    });
});

describe('mergeKodyRuleFindings', () => {
    it('does not carry a location with no known line into the merged list', () => {
        const merges: Array<{ otherLocations: number }> = [];

        const out = mergeKodyRuleFindings<Partial<CodeSuggestion>>(
            [
                {
                    brokenKodyRulesIds: ['rule-1'],
                    relevantFile: 'a.ts',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 2,
                    suggestionContent: 'the longest content wins',
                },
                {
                    brokenKodyRulesIds: ['rule-1'],
                    relevantFile: 'b.ts',
                    suggestionContent: 'no line cited',
                },
                {
                    brokenKodyRulesIds: ['rule-1'],
                    relevantFile: 'c.ts',
                    relevantLinesStart: 5,
                    relevantLinesEnd: 6,
                    suggestionContent: 'short',
                },
            ],
            (merge) => merges.push(merge),
        );

        expect(out).toHaveLength(1);
        expect(out[0].kodyRuleOtherLocations).toEqual(['c.ts:5-6']);
        expect(merges[0].otherLocations).toBe(1);
    });
});
