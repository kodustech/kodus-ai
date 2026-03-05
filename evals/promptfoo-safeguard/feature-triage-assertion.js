/**
 * Feature triage assertion for safeguard eval.
 *
 * Parses the model's feature extraction output, applies the triage logic
 * (same rules as safeguardTriage.service.ts), and compares the resulting
 * action against the expected action.
 *
 * This tests the FULL pipeline: LLM feature extraction → code triage → action.
 */

const { processResponse } = require('./parse-output');

const STRUCTURAL_FEATURES = [
    'has_resource_leak',
    'has_inconsistent_contract',
    'has_wrong_algorithm',
    'has_data_exposure',
    'has_missing_error_handling',
    'has_redundant_work_in_loop',
];

// Hard discard: always discard regardless of structural features
const HARD_DISCARD_FEATURES = [
    'is_quality_opinion',
    'targets_unchanged_code',
];

// Soft speculation: route to VERIFY (not discard) when structural features also present
const SOFT_SPECULATION_FEATURES = [
    'requires_assumed_input',
    'requires_assumed_workload',
    'is_anti_pattern_only',
];

/**
 * Same logic as safeguardTriage.service.ts triageSuggestion (v2)
 */
function triageSuggestion(features) {
    const hasHardDiscard = HARD_DISCARD_FEATURES.some(f => features[f] === true);
    const hasSoftSpeculation = SOFT_SPECULATION_FEATURES.some(f => features[f] === true);
    const hasStructuralDefect = STRUCTURAL_FEATURES.some(f => features[f] === true);

    if (hasHardDiscard) return 'discard';
    if (hasSoftSpeculation && hasStructuralDefect) return 'verify';
    if (hasSoftSpeculation) return 'discard';
    if (hasStructuralDefect) return 'keep';
    return 'verify';
}

function triageToAction(decision, improvedCodeIsCorrect) {
    switch (decision) {
        case 'keep': return improvedCodeIsCorrect ? 'no_changes' : 'update';
        case 'discard': return 'discard';
        case 'verify': return 'discard'; // safe default
    }
}

module.exports = (output, context) => {
    const parsed = processResponse(output);
    if (!parsed) {
        return {
            pass: false,
            score: 0,
            reason: 'TRIAGE_SKIP: Could not parse model output',
        };
    }

    const suggestions = parsed.codeSuggestions;
    const expectedActions = JSON.parse(context.vars.expectedActions || '[]');

    const expectedMap = {};
    for (const ea of expectedActions) {
        expectedMap[ea.id] = ea.action;
    }

    let correct = 0;
    let total = 0;
    let triageCorrect = 0;
    let modelCorrect = 0;
    const details = [];
    const triageDistribution = { keep: 0, discard: 0, verify: 0 };

    for (const suggestion of suggestions) {
        const expected = expectedMap[suggestion.id];
        if (!expected) continue;

        total++;
        const features = suggestion.features || {};
        const triageDecision = triageSuggestion(features);
        const improvedCodeCorrect = features.improvedCode_is_correct !== false;
        const triageAction = triageToAction(triageDecision, improvedCodeCorrect);

        triageDistribution[triageDecision]++;

        // Compare triage action vs expected
        const triageIsCorrect = triageAction === expected;
        if (triageIsCorrect) triageCorrect++;

        // Compare model's own action vs expected
        const modelIsCorrect = suggestion.action === expected;
        if (modelIsCorrect) modelCorrect++;

        // Use triage result as the primary metric
        if (triageIsCorrect) correct++;

        const featureSummary = Object.entries(features)
            .filter(([, v]) => v === true)
            .map(([k]) => k)
            .join(', ') || 'none';

        details.push(
            `  ${suggestion.id}: triage=${triageDecision}→${triageAction} model=${suggestion.action} expected=${expected} ` +
            `[triage:${triageIsCorrect ? 'OK' : 'WRONG'} model:${modelIsCorrect ? 'OK' : 'WRONG'}] features=[${featureSummary}]`
        );
    }

    if (total === 0) {
        return {
            pass: false,
            score: 0,
            reason: 'TRIAGE_FAIL: No matching suggestion IDs found',
        };
    }

    const triageAccuracy = triageCorrect / total;
    const modelAccuracy = modelCorrect / total;
    const reason = [
        `TRIAGE_METRICS triage_accuracy=${triageAccuracy.toFixed(4)} model_accuracy=${modelAccuracy.toFixed(4)}`,
        `  triage_correct=${triageCorrect} model_correct=${modelCorrect} total=${total}`,
        `  distribution: keep=${triageDistribution.keep} discard=${triageDistribution.discard} verify=${triageDistribution.verify}`,
        ...details,
    ].join('\n');

    return {
        pass: triageAccuracy >= 0.7,
        score: triageAccuracy,
        reason,
    };
};
