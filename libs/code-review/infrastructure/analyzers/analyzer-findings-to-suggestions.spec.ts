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
    subject: 'lodash@4.17.11',
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
                finding({ ruleId: 'osv/GHSA-aaa', subject: 'lodash@4.17.11' }),
                finding({
                    ruleId: 'osv/GHSA-bbb',
                    startLine: 9,
                    subject: 'minimist@1.2.0',
                }),
                finding({
                    ruleId: 'osv/GHSA-ccc',
                    startLine: 14,
                    subject: 'axios@1.6.0',
                }),
            ]);

            expect(suggestions).toHaveLength(1);
            expect(suggestions[0].suggestionContent).toContain(
                'lodash@4.17.11',
            );
            expect(suggestions[0].suggestionContent).toContain(
                'minimist@1.2.0',
            );
            expect(suggestions[0].suggestionContent).toContain('axios@1.6.0');
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

        it('counts the packages in its opening line, not the advisories', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                finding({ ruleId: 'osv/GHSA-aaa' }),
                finding({ ruleId: 'osv/GHSA-bbb', startLine: 9 }),
                finding({
                    ruleId: 'osv/GHSA-ccc',
                    startLine: 20,
                    subject: 'axios@1.6.0',
                }),
            ]);

            expect(suggestion.oneSentenceSummary).toContain('2 packages');
        });

        it('reads naturally for a single finding', () => {
            const [suggestion] = analyzerFindingsToSuggestions([finding()]);

            expect(suggestion.oneSentenceSummary).toBe(
                'This change introduces a package with a known vulnerability.',
            );
        });

        it('summarises the tail past the listing cap', () => {
            const many = Array.from({ length: 32 }, (_, i) =>
                finding({
                    ruleId: `osv/GHSA-${i}`,
                    startLine: i + 1,
                    subject: `pkg-${i}@1.0.0`,
                }),
            );

            const [suggestion] = analyzerFindingsToSuggestions(many);

            expect(suggestion.suggestionContent).toContain('and 17 more');
        });
    });

    /**
     * A lockfile bump pulls in advisories by the dozen, and a reader who has to
     * act on them needs the PACKAGES to upgrade. Listing advisories instead
     * spent the whole budget on the first package and never named the other
     * ten — measured on a real bump: 15 axios advisories listed, 10 packages
     * silently summarised as "38 more".
     */
    describe('dependency comments name every package', () => {
        const pkg = (name: string, ids: string[]) =>
            ids.map((id, i) =>
                finding({
                    ruleId: `osv/${id}`,
                    startLine: 100 + name.length + i,
                    subject: name,
                    message: `${name} is affected by ${id}`,
                }),
            );

        it('lists each affected package once', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                ...pkg('axios@1.6.0', ['GHSA-a1', 'GHSA-a2', 'GHSA-a3']),
                ...pkg('lodash@4.15.0', ['GHSA-l1', 'GHSA-l2']),
                ...pkg('minimist@1.2.0', ['GHSA-m1']),
            ]);

            const body = suggestion.suggestionContent ?? '';
            expect(body).toContain('axios@1.6.0');
            expect(body).toContain('lodash@4.15.0');
            expect(body).toContain('minimist@1.2.0');
            // One line per package, not one per advisory.
            expect(body.match(/^- /gm)).toHaveLength(3);
        });

        it('names one advisory per package and counts the rest', () => {
            const [suggestion] = analyzerFindingsToSuggestions(
                pkg('axios@1.6.0', ['GHSA-a1', 'GHSA-a2', 'GHSA-a3']),
            );

            expect(suggestion.suggestionContent).toContain(
                'GHSA-a1 and 2 more',
            );
        });

        it('does not count the advisory when a package has only one', () => {
            const [suggestion] = analyzerFindingsToSuggestions(
                pkg('minimist@1.2.0', ['GHSA-m1']),
            );

            expect(suggestion.suggestionContent).toContain('GHSA-m1');
            expect(suggestion.suggestionContent).not.toContain('and 0 more');
        });

        /**
         * Falls back to the message when the tool gave us no subject, so an
         * analyzer that predates the field still publishes something readable
         * rather than a bullet reading "undefined".
         */
        it('falls back to the message when a finding carries no subject', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                finding({ subject: undefined, message: 'something is wrong' }),
            ]);

            expect(suggestion.suggestionContent).toContain(
                'something is wrong',
            );
            expect(suggestion.suggestionContent).not.toContain('undefined');
        });
    });

    /**
     * betterleaks writes one boilerplate sentence per hit — "generic-api-key
     * has detected secret for file X." — so ten credentials in one file
     * published as ten identical lines carrying no line number. The scanner
     * knows where each hit is; the body has to say so.
     */
    describe('secret comments say where each hit is', () => {
        const secret = (
            line: number,
            message: string,
            path = 'src/config.ts',
        ) =>
            finding({
                tool: 'secrets',
                ruleId: 'generic-api-key',
                path,
                startLine: line,
                endLine: line,
                subject: undefined,
                message,
            });

        it('names the location of a single hit', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                secret(12, 'An API key is committed here'),
            ]);

            expect(suggestion.suggestionContent).toContain('src/config.ts:12');
            expect(suggestion.suggestionContent).toContain(
                'An API key is committed here',
            );
        });

        it('collapses repeated boilerplate into one line per message', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                secret(4, 'generic-api-key has detected secret'),
                secret(9, 'generic-api-key has detected secret'),
                secret(13, 'generic-api-key has detected secret'),
            ]);

            const body = suggestion.suggestionContent ?? '';
            expect(body.match(/^- /gm)).toHaveLength(1);
            expect(body).toContain('src/config.ts:4');
            expect(body).toContain('9');
            expect(body).toContain('13');
        });

        it('still counts every hit in the opening line', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                secret(4, 'same'),
                secret(9, 'same'),
            ]);

            expect(suggestion.oneSentenceSummary).toContain('2 credentials');
        });

        it('keeps hits in different files apart', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                secret(4, 'same', 'src/a.ts'),
                secret(9, 'same', 'src/b.ts'),
            ]);

            expect(suggestion.suggestionContent).toContain('src/a.ts:4');
            expect(suggestion.suggestionContent).toContain('src/b.ts:9');
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

            expect(suggestion.oneSentenceSummary).toContain('a package');
        });

        // One lockfile line can legitimately carry several advisories.
        it('keeps different advisories on the same line', () => {
            const [suggestion] = analyzerFindingsToSuggestions([
                finding({ ruleId: 'osv/GHSA-aaa' }),
                finding({ ruleId: 'osv/GHSA-bbb' }),
            ]);

            expect(suggestion.suggestionContent).toContain(
                'GHSA-aaa and 1 more',
            );
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

        /**
         * Its own category rather than `security`, so a scanner-proved fact is
         * distinguishable from a model's security opinion everywhere the label
         * is read — rank, badge, and anyone filtering a review by category.
         */
        it('publishes under its own category, not the model\'s', () => {
            const [suggestion] = analyzerFindingsToSuggestions([finding()]);

            expect(suggestion.label).toBe('deterministic');
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
