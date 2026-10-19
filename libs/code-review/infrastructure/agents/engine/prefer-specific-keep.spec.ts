import { ANALYZER_SOURCE } from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { isSameSpot, preferSpecificKeep } from './prefer-specific-keep';

const at = (
    relevantFile: string,
    relevantLinesStart: number,
    relevantLinesEnd: number,
    extra: Partial<CodeSuggestion> = {},
): Partial<CodeSuggestion> => ({
    relevantFile,
    relevantLinesStart,
    relevantLinesEnd,
    label: 'bug',
    ...extra,
});

describe('preferSpecificKeep', () => {
    it('keeps the finding on the defective lines over the one on the whole function (#2157)', () => {
        // The dedup model kept the 14-32 finding for its longer text; the
        // comment then sat on the signature, the loop only under "Also found in".
        const suggestions = [at('bulk.ts', 22, 31), at('bulk.ts', 14, 32)];

        expect(
            preferSpecificKeep([{ keep: 1, duplicates: [0] }], suggestions),
        ).toEqual([{ keep: 0, duplicates: [1] }]);
    });

    it('picks the narrowest of several nested ranges', () => {
        const suggestions = [
            at('a.ts', 1, 40),
            at('a.ts', 10, 30),
            at('a.ts', 12, 14),
        ];

        expect(
            preferSpecificKeep([{ keep: 0, duplicates: [1, 2] }], suggestions),
        ).toEqual([{ keep: 2, duplicates: [0, 1] }]);
    });

    it.each([
        ['another file', at('b.ts', 22, 31)],
        ['an overlapping range it does not contain', at('a.ts', 10, 22)],
        ['the same range', at('a.ts', 14, 32)],
        ['no lines', { relevantFile: 'a.ts', label: 'bug' }],
    ])('leaves the model keep when the duplicate is on %s', (_, dup) => {
        const group = { keep: 0, duplicates: [1] };

        expect(preferSpecificKeep([group], [at('a.ts', 14, 32), dup])).toEqual([
            group,
        ]);
    });

    // The survivor's severity and fix are what ship: the classifier re-rates
    // its text and the team's severity floor can drop it. A narrower finding
    // that is rated lower, or carries no fix where the kept one has one, must
    // not replace it.
    it.each([
        ['is rated lower', { severity: 'low' }, { severity: 'high' }],
        [
            'has no fix and the kept one has',
            { improvedCode: '' },
            { improvedCode: 'fixed()' },
        ],
    ])(
        'leaves the model keep when the narrower duplicate %s',
        (_, narrow, wide) => {
            const group = { keep: 1, duplicates: [0] };
            const suggestions = [
                at('bulk.ts', 22, 31, {
                    severity: 'high',
                    improvedCode: 'a()',
                    ...narrow,
                }),
                at('bulk.ts', 14, 32, {
                    severity: 'high',
                    improvedCode: 'b()',
                    ...wide,
                }),
            ];

            expect(preferSpecificKeep([group], suggestions)).toEqual([group]);
        },
    );

    it.each([
        ['rated higher', { severity: 'critical' }, { severity: 'high' }],
        [
            'rated the same, in another case',
            { severity: 'HIGH' },
            { severity: 'high' },
        ],
        [
            'with a fix where the kept one has none',
            { improvedCode: 'a()' },
            { improvedCode: '' },
        ],
    ])('promotes a narrower duplicate %s', (_, narrow, wide) => {
        const suggestions = [
            at('bulk.ts', 22, 31, {
                severity: 'high',
                improvedCode: 'a()',
                ...narrow,
            }),
            at('bulk.ts', 14, 32, {
                severity: 'high',
                improvedCode: 'b()',
                ...wide,
            }),
        ];

        expect(
            preferSpecificKeep([{ keep: 1, duplicates: [0] }], suggestions),
        ).toEqual([{ keep: 0, duplicates: [1] }]);
    });

    it('skips a narrower duplicate that does not qualify and takes the next one', () => {
        const suggestions = [
            at('a.ts', 1, 40, { severity: 'high' }),
            at('a.ts', 12, 14, { severity: 'low' }),
            at('a.ts', 10, 30, { severity: 'high' }),
        ];

        expect(
            preferSpecificKeep([{ keep: 0, duplicates: [1, 2] }], suggestions),
        ).toEqual([{ keep: 2, duplicates: [0, 1] }]);
    });

    it('never displaces a scanner finding', () => {
        const scanner = at('a.ts', 1, 40, {
            evidence: { source: ANALYZER_SOURCE } as CodeSuggestion['evidence'],
        });
        const group = { keep: 0, duplicates: [1] };

        expect(
            preferSpecificKeep([group], [scanner, at('a.ts', 5, 6)]),
        ).toEqual([group]);
    });

    it('ignores indices outside the list', () => {
        const group = { keep: 0, duplicates: [7] };

        expect(preferSpecificKeep([group], [at('a.ts', 1, 9)])).toEqual([
            group,
        ]);
    });
});

describe('isSameSpot', () => {
    it.each([
        [at('a.ts', 14, 32), at('a.ts', 22, 31), true],
        [at('a.ts', 22, 31), at('a.ts', 14, 32), true],
        [at('a.ts', 22, 31), at('a.ts', 22, 31), true],
        [at('a.ts', 10, 22), at('a.ts', 14, 32), false],
        [at('a.ts', 22, 31), at('b.ts', 22, 31), false],
    ])('%o and %o → %s', (a, b, expected) => {
        expect(isSameSpot(a, b)).toBe(expected);
    });
});
