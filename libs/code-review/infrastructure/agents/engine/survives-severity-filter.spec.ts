import { ANALYZER_SOURCE } from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { survivesSeverityFilter } from './survives-severity-filter';

const HIGH = ['critical', 'high'];

const suggestion = (
    over: Partial<CodeSuggestion> = {},
): Partial<CodeSuggestion> => ({
    label: 'security',
    severity: 'medium',
    ...over,
});

const analyzer = (
    over: Partial<CodeSuggestion> = {},
): Partial<CodeSuggestion> =>
    suggestion({
        evidence: { source: ANALYZER_SOURCE, ruleId: 'osv/GHSA-a' } as any,
        ...over,
    });

describe('survivesSeverityFilter', () => {
    it('drops a model finding below the threshold', () => {
        expect(survivesSeverityFilter(suggestion(), HIGH, false)).toBe(false);
    });

    it('keeps a model finding at the threshold', () => {
        expect(
            survivesSeverityFilter(
                suggestion({ severity: 'high' }),
                HIGH,
                false,
            ),
        ).toBe(true);
    });

    /**
     * Deterministic findings are opted into per tool and published as one
     * comment per category, and the review prompt now tells the agent NOT to
     * restate them. A threshold that drops the scanner's only copy therefore
     * deletes a proven vulnerability from the review outright, rather than
     * merely lowering the noise — the same reasoning that already exempts
     * Kody Rules.
     */
    it('keeps a deterministic finding below the threshold', () => {
        expect(survivesSeverityFilter(analyzer(), HIGH, false)).toBe(true);
    });

    it('keeps a deterministic finding even when rule filtering is on', () => {
        expect(survivesSeverityFilter(analyzer(), HIGH, true)).toBe(true);
    });

    it('keeps kody rules below the threshold by default', () => {
        expect(
            survivesSeverityFilter(
                suggestion({ label: 'kody_rules' }),
                HIGH,
                false,
            ),
        ).toBe(true);
    });

    it('filters kody rules when the team opted in', () => {
        expect(
            survivesSeverityFilter(
                suggestion({ label: 'kody_rules' }),
                HIGH,
                true,
            ),
        ).toBe(false);
    });

    it('treats a missing severity as medium', () => {
        expect(
            survivesSeverityFilter(
                suggestion({ severity: undefined }),
                HIGH,
                false,
            ),
        ).toBe(false);
    });
});
