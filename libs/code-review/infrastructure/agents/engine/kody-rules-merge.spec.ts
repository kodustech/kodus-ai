import {
    mergeKodyRuleFindings,
    otherLocationsToRender,
} from './kody-rules-merge';

describe('mergeKodyRuleFindings', () => {
    it('lists only the duplicates that name a file as other locations', () => {
        const [kept] = mergeKodyRuleFindings([
            {
                brokenKodyRulesIds: ['rule-1'],
                relevantFile: 'a.ts',
                relevantLinesStart: 1,
                relevantLinesEnd: 2,
                suggestionContent: 'The longest text is the one kept.',
            },
            {
                brokenKodyRulesIds: ['rule-1'],
                suggestionContent: 'No file on this one.',
            },
            {
                brokenKodyRulesIds: ['rule-1'],
                relevantFile: 'b.ts',
                relevantLinesStart: 3,
                relevantLinesEnd: 4,
                suggestionContent: 'Same rule in b.',
            },
        ]);

        expect(kept.kodyRuleOtherLocations).toEqual(['b.ts:3-4']);
    });
});

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
