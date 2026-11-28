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

    // Kody review on #2751: a file-anchored finding is posted PR-level, so it
    // is never folded into an inline one, and keeps its own file.
    it('never folds a file-anchored finding inline and keeps it apart from line-less ones', () => {
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
        ]);
        expect(out[0].kodyRuleOtherLocations).toBeUndefined();
        expect(out[2].kodyRuleOtherLocations).toEqual(['d.cs']);
    });

    // Junior's review of #2751: every file shard sees the PR title, so a
    // title rule scoped to files flags each matching file. One comment per
    // file posted the same claim four times where main posted one.
    it('posts a line-less rule finding flagged on several files once, naming the others', () => {
        const title = (file: string) => ({
            brokenKodyRulesIds: ['rule-title'],
            relevantFile: file,
            suggestionContent: 'The PR title "fix stuff" names no scope.',
        });

        const out = mergeKodyRuleFindings<Partial<CodeSuggestion>>(
            ['src/A.cs', 'src/B.cs', 'src/C.cs', 'src/D.cs'].map(title),
        );

        expect(out).toHaveLength(1);
        expect(out[0].relevantFile).toBe('src/A.cs');
        expect(out[0].kodyRuleOtherLocations).toEqual([
            'src/B.cs',
            'src/C.cs',
            'src/D.cs',
        ]);
    });

    it('keeps the claim of every file a line-less finding folded', () => {
        const out = mergeKodyRuleFindings<Partial<CodeSuggestion>>(
            ['src/A.cs', 'src/B.cs'].map((file) => ({
                brokenKodyRulesIds: ['rule-name'],
                relevantFile: file,
                suggestionContent: `${file} lacks the prefix, rewritten`,
                repeatClaim: `${file} lacks the prefix.`,
            })),
        );

        expect(out).toHaveLength(1);
        expect(out[0].repeatClaims).toEqual([
            { file: 'src/A.cs', claim: 'src/A.cs lacks the prefix.' },
            { file: 'src/B.cs', claim: 'src/B.cs lacks the prefix.' },
        ]);
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
