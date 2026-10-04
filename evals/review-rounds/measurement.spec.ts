// eslint-disable-next-line @typescript-eslint/no-require-imports
const { assertCompleteRuleReview } = require('./measurement');
import { buildKodyRulesPartialWarning } from '@libs/code-review/infrastructure/agents/engine/review-warnings';

describe('review-rounds measurement completeness', () => {
    it('rejects a production partial-shard warning before empty findings can pass suppression', () => {
        const warning = buildKodyRulesPartialWarning({
            failed: 1,
            total: 2,
            modelName: 'eval-model',
            agentName: 'kody-rules',
        });
        expect(() => assertCompleteRuleReview([warning])).toThrow(
            /INFRA.*KODY_RULES_PARTIAL/,
        );
    });

    it('rejects a rule whose declared repository context could not be retrieved', () => {
        expect(() =>
            assertCompleteRuleReview([
                {
                    kind: 'RULE_CONTEXT_UNAVAILABLE',
                    reason: 'lookup_unavailable',
                    detail: 'Missing sibling file',
                },
            ]),
        ).toThrow(/INFRA.*Missing sibling file/);
    });

    it('allows a complete review and non-provider fidelity notices', () => {
        expect(() => assertCompleteRuleReview()).not.toThrow();
        expect(() =>
            assertCompleteRuleReview([{ kind: 'BAD_FIX_DOWNGRADED' }]),
        ).not.toThrow();
    });
});
