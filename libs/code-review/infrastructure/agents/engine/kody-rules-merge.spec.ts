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

        expect(out).toHaveLength(1);
        expect(out[0].kodyRuleOtherLocations).toEqual(['c.ts:5-6']);
        expect(merges[0].otherLocations).toBe(1);
    });

    it('reports the scope of the kept finding, not of the group', () => {
        const merges: Array<{ scope: 'pr' | 'file' }> = [];

        mergeKodyRuleFindings<Partial<CodeSuggestion>>(
            [
                {
                    brokenKodyRulesIds: ['rule-1'],
                    relevantFile: 'a.ts',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 2,
                    suggestionContent: 'short',
                },
                {
                    // A rule about the PR itself: the longest text, so it is
                    // the finding the comment is written from.
                    brokenKodyRulesIds: ['rule-1'],
                    relevantFile: 'b.ts',
                    suggestionContent:
                        'the title must name the affected module and the change',
                },
            ],
            (merge) => merges.push(merge),
        );

        expect(merges[0].scope).toBe('pr');
    });

    // #2656: atoms of one decomposed rule share its uuid but are different
    // violations, so one must not become another's "Also found in".
    it('keeps the findings of different atoms of one rule apart', () => {
        const merged = mergeKodyRuleFindings([
            {
                brokenKodyRulesIds: ['rule-1'],
                kodyRuleUnitId: 'rule-1-atom-puts',
                relevantFile: 'report_service.rb',
                relevantLinesStart: 8,
                relevantLinesEnd: 8,
                suggestionContent: 'Console write bypasses Rails.logger.',
            },
            {
                brokenKodyRulesIds: ['rule-1'],
                kodyRuleUnitId: 'rule-1-atom-pry',
                relevantFile: 'export_job.rb',
                relevantLinesStart: 4,
                relevantLinesEnd: 4,
                suggestionContent: 'binding.pry left in.',
            },
            {
                brokenKodyRulesIds: ['rule-1'],
                kodyRuleUnitId: 'rule-1-atom-puts',
                relevantFile: 'export_job.rb',
                relevantLinesStart: 9,
                relevantLinesEnd: 9,
                suggestionContent: 'puts here too.',
            },
        ]);

        expect(
            merged.map((s) => [
                s.relevantFile,
                s.relevantLinesStart,
                s.kodyRuleOtherLocations,
            ]),
        ).toEqual([
            ['report_service.rb', 8, ['export_job.rb:9-9']],
            ['export_job.rb', 4, undefined],
        ]);
    });

    it('keeps one finding per atom of a PR-level rule', () => {
        const merged = mergeKodyRuleFindings([
            {
                brokenKodyRulesIds: ['rule-1'],
                kodyRuleUnitId: 'rule-1-atom-a',
                suggestionContent: 'Atom a, detailed.',
            },
            {
                brokenKodyRulesIds: ['rule-1'],
                kodyRuleUnitId: 'rule-1-atom-a',
                suggestionContent: 'Atom a.',
            },
            {
                brokenKodyRulesIds: ['rule-1'],
                kodyRuleUnitId: 'rule-1-atom-b',
                suggestionContent: 'Atom b.',
            },
        ]);

        expect(merged.map((s) => s.suggestionContent)).toEqual([
            'Atom a, detailed.',
            'Atom b.',
        ]);
    });
});
