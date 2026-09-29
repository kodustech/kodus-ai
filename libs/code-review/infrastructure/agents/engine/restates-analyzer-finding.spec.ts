import { ANALYZER_SOURCE } from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { restatesAnalyzerFinding } from './restates-analyzer-finding';

const analyzer = (
    over: Partial<CodeSuggestion> = {},
): Partial<CodeSuggestion> => ({
    relevantFile: 'src/config.ts',
    relevantLinesStart: 4,
    relevantLinesEnd: 4,
    // What analyzerFindingsToSuggestions actually writes.
    label: 'deterministic',
    evidence: { source: ANALYZER_SOURCE, ruleId: 'generic-api-key' } as any,
    ...over,
});

const agent = (
    over: Partial<CodeSuggestion> = {},
): Partial<CodeSuggestion> => ({
    relevantFile: 'src/config.ts',
    relevantLinesStart: 3,
    relevantLinesEnd: 29,
    label: 'security',
    ...over,
});

describe('restatesAnalyzerFinding', () => {
    /**
     * The scanner asserts a fact at a location. An agent finding covering that
     * same span is a restatement of it, and deciding that does not need
     * semantic similarity — which matters because the embedding tier is
     * unavailable in some deployments and vetoes every merge when it is.
     */
    it('is true when the agent span covers the analyzer line', () => {
        expect(restatesAnalyzerFinding(agent(), analyzer())).toBe(true);
    });

    it('is false when the kept finding is not from an analyzer', () => {
        expect(restatesAnalyzerFinding(agent(), agent())).toBe(false);
    });

    it('is false in a different file', () => {
        expect(
            restatesAnalyzerFinding(
                agent({ relevantFile: 'src/other.ts' }),
                analyzer(),
            ),
        ).toBe(false);
    });

    it('is false when the spans do not overlap', () => {
        expect(
            restatesAnalyzerFinding(
                agent({ relevantLinesStart: 40, relevantLinesEnd: 50 }),
                analyzer(),
            ),
        ).toBe(false);
    });

    it('is true when the analyzer span covers the agent line', () => {
        expect(
            restatesAnalyzerFinding(
                agent({ relevantLinesStart: 10, relevantLinesEnd: 10 }),
                analyzer({ relevantLinesStart: 4, relevantLinesEnd: 20 }),
            ),
        ).toBe(true);
    });

    /**
     * A scanner reports a credential; an agent finding on the same lines about
     * a DIFFERENT kind of defect is not a restatement of it. Measured on a real
     * PR: a `bug` finding about String.replace semantics spanned the same lines
     * as the secrets scanner's hit and would have been swallowed.
     */
    it('is false when the findings are about different kinds of defect', () => {
        expect(
            restatesAnalyzerFinding(agent({ label: 'bug' }), analyzer()),
        ).toBe(false);
        expect(
            restatesAnalyzerFinding(agent({ label: 'performance' }), analyzer()),
        ).toBe(false);
    });

    /** Missing line numbers must not be read as an overlap at line 0. */
    it('is false when either side has no line range', () => {
        expect(
            restatesAnalyzerFinding(
                agent({
                    relevantLinesStart: undefined,
                    relevantLinesEnd: undefined,
                }),
                analyzer(),
            ),
        ).toBe(false);
    });
});
