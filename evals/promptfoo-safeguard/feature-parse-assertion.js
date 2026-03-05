/**
 * Parse assertion for feature extraction safeguard eval.
 * Validates that the model output contains codeSuggestions with features objects.
 */

const { processResponse } = require('./parse-output');

const EXPECTED_FEATURES = [
    'has_resource_leak',
    'has_inconsistent_contract',
    'has_wrong_algorithm',
    'has_data_exposure',
    'has_missing_error_handling',
    'has_redundant_work_in_loop',
    'requires_assumed_input',
    'requires_assumed_workload',
    'is_quality_opinion',
    'is_anti_pattern_only',
    'targets_unchanged_code',
    'improvedCode_is_correct',
];

module.exports = (output, context) => {
    const parsed = processResponse(output);

    if (!parsed) {
        return {
            pass: false,
            score: 0,
            reason: 'PARSE_FAIL: Could not parse feature extraction output as JSON',
        };
    }

    const suggestions = parsed.codeSuggestions;

    if (!suggestions || suggestions.length === 0) {
        return {
            pass: false,
            score: 0,
            reason: 'PARSE_FAIL: Missing or empty codeSuggestions array',
        };
    }

    // Validate each suggestion has id and features
    const errors = [];
    let featuresFound = 0;

    suggestions.forEach((s, i) => {
        if (!s.id || typeof s.id !== 'string') {
            errors.push(`[${i}] missing or invalid id`);
        }

        if (!s.features || typeof s.features !== 'object') {
            errors.push(`[${i}] missing features object`);
            return;
        }

        featuresFound++;

        // Check that all expected features are present and boolean
        const missingFeatures = [];
        const nonBoolFeatures = [];

        for (const feat of EXPECTED_FEATURES) {
            if (!(feat in s.features)) {
                missingFeatures.push(feat);
            } else if (typeof s.features[feat] !== 'boolean') {
                nonBoolFeatures.push(`${feat}=${typeof s.features[feat]}`);
            }
        }

        if (missingFeatures.length > 0) {
            errors.push(`[${i}] missing features: ${missingFeatures.join(', ')}`);
        }
        if (nonBoolFeatures.length > 0) {
            errors.push(`[${i}] non-boolean features: ${nonBoolFeatures.join(', ')}`);
        }
    });

    // Check completeness
    const expectedIds = JSON.parse(context.vars.expectedSuggestionIds || '[]');
    const outputIds = new Set(suggestions.map(s => s.id));
    const missingIds = expectedIds.filter(id => !outputIds.has(id));

    if (missingIds.length > 0) {
        errors.push(`Missing suggestions for IDs: ${missingIds.join(', ')}`);
    }

    if (errors.length > 0) {
        const score = featuresFound / Math.max(suggestions.length, 1);
        return {
            pass: score >= 0.8,
            score,
            reason: `FEATURE_SCHEMA: ${errors.join('; ')}`,
        };
    }

    return {
        pass: true,
        score: 1.0,
        reason: `FEATURE_PARSE_OK: ${suggestions.length} suggestions with valid features`,
    };
};
