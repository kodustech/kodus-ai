import { AnalyzerFinding } from './analyzer-finding.type';
import { analyzerFindingsToSuggestions } from './analyzer-findings-to-suggestions';

const finding = (overrides: Partial<AnalyzerFinding> = {}): AnalyzerFinding => ({
    ruleId: 'kodus-sqli-concat-go',
    path: 'src/db/orders.go',
    startLine: 42,
    endLine: 42,
    severity: 'error',
    message: 'SQL statement assembled by string concatenation.',
    ...overrides,
});

describe('analyzerFindingsToSuggestions', () => {
    it('anchors the suggestion to the reported location', () => {
        const [suggestion] = analyzerFindingsToSuggestions([finding()]);

        expect(suggestion.relevantFile).toBe('src/db/orders.go');
        expect(suggestion.relevantLinesStart).toBe(42);
        expect(suggestion.relevantLinesEnd).toBe(42);
    });

    // Without this the comment reads as if the model reasoned its way to the
    // finding, and the issue's "identify source, rule, location" criterion is
    // unmet.
    it('carries provenance naming the rule and the source', () => {
        const [suggestion] = analyzerFindingsToSuggestions([finding()]);

        expect(suggestion.evidence).toEqual({
            source: 'kodus-rule-pack',
            ruleId: 'kodus-sqli-concat-go',
            analyzerSeverity: 'error',
        });
    });

    it('labels analyzer findings as security', () => {
        const [suggestion] = analyzerFindingsToSuggestions([finding()]);

        expect(suggestion.label).toBe('security');
    });

    it.each([
        ['error', 'high'],
        ['warning', 'medium'],
        ['note', 'low'],
    ])('maps %s severity to %s', (analyzerSeverity, expected) => {
        const [suggestion] = analyzerFindingsToSuggestions([
            finding({ severity: analyzerSeverity as AnalyzerFinding['severity'] }),
        ]);

        expect(suggestion.severity).toBe(expected);
    });

    it('uses the rule message as the suggestion content', () => {
        const [suggestion] = analyzerFindingsToSuggestions([finding()]);

        expect(suggestion.suggestionContent).toContain(
            'SQL statement assembled by string concatenation.',
        );
    });

    // A reader has to be able to tell a rule match from model inference.
    it('names the rule in the comment body', () => {
        const [suggestion] = analyzerFindingsToSuggestions([finding()]);

        expect(suggestion.suggestionContent).toContain('kodus-sqli-concat-go');
        expect(suggestion.suggestionContent).toContain('not by model inference');
    });

    it('returns nothing for no findings', () => {
        expect(analyzerFindingsToSuggestions([])).toEqual([]);
    });

    // Two rules firing on one line is one problem to a reader, not two
    // comments on the same line.
    it('keeps only the highest-severity finding per file and line', () => {
        const suggestions = analyzerFindingsToSuggestions([
            finding({ ruleId: 'rule-a', severity: 'warning' }),
            finding({ ruleId: 'rule-b', severity: 'error' }),
        ]);

        expect(suggestions).toHaveLength(1);
        expect(suggestions[0].evidence?.ruleId).toBe('rule-b');
    });

    it('keeps findings on different lines of the same file', () => {
        const suggestions = analyzerFindingsToSuggestions([
            finding({ startLine: 10, endLine: 10 }),
            finding({ startLine: 20, endLine: 20 }),
        ]);

        expect(suggestions).toHaveLength(2);
    });
});
