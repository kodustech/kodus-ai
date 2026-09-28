import { AnalyzerFinding } from './analyzer-finding.type';
import {
    ANALYZER_SOURCE,
    analyzerFindingsToSuggestions,
} from './analyzer-findings-to-suggestions';

const finding = (over: Partial<AnalyzerFinding> = {}): AnalyzerFinding => ({
    ruleId: 'osv/GHSA-aaa',
    path: 'package-lock.json',
    startLine: 4,
    endLine: 4,
    severity: 'error',
    message: 'lodash@4.17.11 is affected by GHSA-aaa',
    tool: 'dependencies',
    ...over,
});

describe('analyzerFindingsToSuggestions', () => {
    /**
     * The reason this groups at all: across 130 real dependency PRs the worst
     * produced 32 findings even after filtering to what the change introduced.
     * As separate comments that is a wall, not a review.
     */
    describe('one comment per category', () => {
        it('collapses many dependency findings into a single suggestion', () => {
            const suggestions = analyzerFindingsToSuggestions([
                finding({
                    ruleId: 'osv/GHSA-aaa',
                    message: 'lodash is affected',
                }),
                finding({
                    ruleId: 'osv/GHSA-bbb',
                    startLine: 9,
                    message: 'minimist is affected',
                }),
                finding({
                    ruleId: 'osv/GHSA-ccc',
                    startLine: 14,
                    message: 'axios is affected',
                }),
            ]);

            expect(suggestions).toHaveLength(1);
            expect(suggestions[0].suggestionContent).toContain(
                'lodash is affected',
            );
            expect(suggestions[0].suggestionContent).toContain(
                'minimist is affected',
            );
            expect(suggestions[0].suggestionContent).toContain(
                'axios is affected',
            );
        });

        it('keeps dependencies and secrets as separate comments', () => {
            const suggestions = analyzerFindingsToSuggestions([
                finding(),
                finding({
                    tool: 'secrets',
                    ruleId: 'github-pat',
                    path: 'scripts/publish.js',
                    startLine: 1,
                    message: 'GitHub token committed',
                }),
            ]);

            expect(suggestions).toHaveLength(2);
            expect(suggestions.map((s) => s.relevantFile).sort()).toEqual([
                'package-lock.json',
                'scripts/publish.js',
            ]);
        });

        it('counts the findings in its opening line', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                finding({ ruleId: 'osv/GHSA-aaa' }),
                finding({ ruleId: 'osv/GHSA-bbb', startLine: 9 }),
            ]);

            expect(suggestion.oneSentenceSummary).toContain('2 dependencies');
        });

        it('reads naturally for a single finding', () => {
            const [suggestion] = analyzerFindingsToSuggestions([finding()]);

            expect(suggestion.oneSentenceSummary).toBe(
                'This change introduces a dependency with a known vulnerability.',
            );
        });

        it('summarises the tail past the listing cap', () => {
            const many = Array.from({ length: 32 }, (_, i) =>
                finding({ ruleId: `osv/GHSA-${i}`, startLine: i + 1 }),
            );

            const [suggestion] = analyzerFindingsToSuggestions(many);

            expect(suggestion.suggestionContent).toContain('and 17 more');
        });
    });

    describe('where the comment lands', () => {
        it('anchors on the most severe finding', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                finding({
                    ruleId: 'osv/GHSA-low',
                    severity: 'note',
                    startLine: 2,
                }),
                finding({
                    ruleId: 'osv/GHSA-high',
                    severity: 'error',
                    startLine: 40,
                }),
            ]);

            expect(suggestion.relevantLinesStart).toBe(40);
        });

        it('takes the earliest line when severity ties', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                finding({
                    ruleId: 'osv/GHSA-a',
                    severity: 'warning',
                    startLine: 30,
                }),
                finding({
                    ruleId: 'osv/GHSA-b',
                    severity: 'warning',
                    startLine: 8,
                }),
            ]);

            expect(suggestion.relevantLinesStart).toBe(8);
        });

        it('carries the worst severity of the group', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                finding({ ruleId: 'osv/GHSA-a', severity: 'note' }),
                finding({
                    ruleId: 'osv/GHSA-b',
                    severity: 'error',
                    startLine: 9,
                }),
            ]);

            expect(suggestion.severity).toBe('high');
        });
    });

    describe('deduplication', () => {
        it('drops an identical rule on an identical line', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                finding(),
                finding(),
            ]);

            expect(suggestion.oneSentenceSummary).toContain('a dependency');
        });

        // One lockfile line can legitimately carry several advisories.
        it('keeps different advisories on the same line', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                finding({ ruleId: 'osv/GHSA-aaa', message: 'first' }),
                finding({ ruleId: 'osv/GHSA-bbb', message: 'second' }),
            ]);

            expect(suggestion.suggestionContent).toContain('first');
            expect(suggestion.suggestionContent).toContain('second');
        });
    });

    describe('provenance', () => {
        it('records every rule that fired without naming them in the body', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                finding({ ruleId: 'osv/GHSA-aaa' }),
                finding({ ruleId: 'osv/GHSA-bbb', startLine: 9 }),
            ]);

            expect(suggestion.evidence).toEqual(
                expect.objectContaining({
                    source: ANALYZER_SOURCE,
                    ruleId: 'osv/GHSA-aaa,osv/GHSA-bbb',
                }),
            );
        });

        /**
         * An advisory id inside a dependency message is the SUBSTANCE of the
         * finding and belongs in the body. What stays out is our own rule
         * identifier, which tells the author nothing.
         */
        it('keeps our rule identifier out of the body', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                finding({
                    tool: 'secrets',
                    ruleId: 'github-pat',
                    path: 'scripts/publish.js',
                    startLine: 1,
                    message: 'A GitHub token is committed here',
                }),
            ]);

            expect(suggestion.suggestionContent).toContain(
                'A GitHub token is committed here',
            );
            expect(suggestion.suggestionContent).not.toContain('github-pat');
            expect(suggestion.suggestionContent).not.toContain(ANALYZER_SOURCE);
            expect(suggestion.evidence).toEqual(
                expect.objectContaining({ ruleId: 'github-pat' }),
            );
        });

        it('offers no rewrite, because a rule does not know the fix', () => {
            const [suggestion] = analyzerFindingsToSuggestions([finding()]);

            expect(suggestion.improvedCode).toBe('');
        });
    });

    it('returns nothing when there are no findings', () => {
        expect(analyzerFindingsToSuggestions([])).toEqual([]);
    });
});
