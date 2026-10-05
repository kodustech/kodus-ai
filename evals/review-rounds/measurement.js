// An empty review after a provider/context failure is not suppression evidence.
function assertCompleteRuleReview(warnings = []) {
    const failed = warnings.filter((w) =>
        ['KODY_RULES_PARTIAL', 'RULE_CONTEXT_UNAVAILABLE'].includes(w.kind),
    );
    if (failed.length) {
        throw new Error(
            `INFRA: Kody Rules were not fully evaluated: ${failed.map((w) => `${w.kind}: ${w.detail || w.reason}`).join('; ')}`,
        );
    }
}

module.exports = { assertCompleteRuleReview };
