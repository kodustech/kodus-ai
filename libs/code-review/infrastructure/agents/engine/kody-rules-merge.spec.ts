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
    it('lists only the duplicates that name a file as other locations', () => {
        const [kept] = mergeKodyRuleFindings<Partial<CodeSuggestion>>([
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

    it('does not carry a location with no known line into the merged list', () => {
        const merges: Array<{ scope: 'pr' | 'file'; otherLocations: number }> =
            [];

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
                    relevantLinesStart: 3,
                    relevantLinesEnd: 3,
                    suggestionContent: 'lines but no file',
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

        expect(out).toHaveLength(3);
        expect(out[0].kodyRuleOtherLocations).toEqual(['c.ts:5-6']);
        expect(out.slice(1).map((s) => s.suggestionContent)).toEqual([
            'no line cited',
            'lines but no file',
        ]);
        expect(merges).toEqual([
            expect.objectContaining({ scope: 'file', otherLocations: 1 }),
        ]);
    });

    // QA M6/M7 on #2420: the line-less finding had the longest text, so it
    // was kept and posted PR-level, and the lined AverageDues.cs:1-1 lived on
    // only as text in its "Also found in": the PR-level record has no field
    // for it, and the implementation check never read it.
    it('never folds a lined finding under a line-less one', () => {
        const out = mergeKodyRuleFindings<Partial<CodeSuggestion>>([
            {
                brokenKodyRulesIds: ['rule-1'],
                relevantFile: 'AverageDues.cs',
                relevantLinesStart: 1,
                relevantLinesEnd: 1,
                suggestionContent: 'short',
            },
            {
                brokenKodyRulesIds: ['rule-1'],
                relevantFile: 'CheckinReport.cs',
                suggestionContent:
                    'the file name must start with the qa2420_ prefix, and this one does not',
            },
        ]);

        expect(out).toEqual([
            expect.objectContaining({
                relevantFile: 'AverageDues.cs',
                relevantLinesStart: 1,
            }),
            expect.objectContaining({ relevantFile: 'CheckinReport.cs' }),
        ]);
        expect(out[1].relevantLinesStart).toBeUndefined();
        expect(out[1].kodyRuleOtherLocations).toBeUndefined();
    });

    // Kody review on #2751: a file-name rule broken by two files is two
    // violations, and a file-anchored finding is posted PR-level, so neither
    // may be folded into one record.
    it('keeps one PR-level finding per file and never folds a file-anchored one inline', () => {
        const out = mergeKodyRuleFindings<Partial<CodeSuggestion>>([
            {
                brokenKodyRulesIds: ['rule-1'],
                relevantFile: 'a.cs',
                relevantLinesStart: 4,
                suggestionContent: 'inline',
            },
            {
                brokenKodyRulesIds: ['rule-1'],
                relevantFile: 'b.cs',
                relevantLinesStart: 90,
                fileAnchored: true,
                suggestionContent: 'outside the diff, the longest text of all',
            },
            {
                brokenKodyRulesIds: ['rule-1'],
                relevantFile: 'c.cs',
                suggestionContent: 'c.cs lacks the prefix',
            },
            {
                brokenKodyRulesIds: ['rule-1'],
                relevantFile: 'd.cs',
                suggestionContent: 'd.cs lacks the prefix',
            },
        ]);

        expect(out.map((s) => s.relevantFile)).toEqual([
            'a.cs',
            'b.cs',
            'c.cs',
            'd.cs',
        ]);
        expect(out[0].kodyRuleOtherLocations).toBeUndefined();
    });

    it('keeps the lines of file-anchored findings collapsed on one file', () => {
        const out = mergeKodyRuleFindings<Partial<CodeSuggestion>>([
            {
                brokenKodyRulesIds: ['rule-1'],
                relevantFile: 'b.cs',
                relevantLinesStart: 90,
                fileAnchored: true,
                suggestionContent: 'outside the diff, the longest',
            },
            {
                brokenKodyRulesIds: ['rule-1'],
                relevantFile: 'b.cs',
                relevantLinesStart: 120,
                relevantLinesEnd: 122,
                fileAnchored: true,
                suggestionContent: 'also outside',
            },
        ]);

        expect(out).toHaveLength(1);
        expect(out[0].relevantLinesStart).toBe(90);
        expect(out[0].kodyRuleOtherLocations).toEqual(['b.cs:120-122']);
    });
});
