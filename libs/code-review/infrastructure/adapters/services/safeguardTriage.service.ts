import {
    SafeguardFeatureSet,
    STRUCTURAL_DEFECT_FEATURES,
} from '@libs/common/utils/langchainCommon/prompts/codeReviewSafeguardFeatures';

export type TriageDecision = 'keep' | 'discard' | 'verify';

/**
 * "Hard" speculation features that always mean discard,
 * regardless of structural features.
 */
const HARD_DISCARD_FEATURES: (keyof SafeguardFeatureSet)[] = [
    'is_quality_opinion',
    'targets_unchanged_code',
];

/**
 * "Soft" speculation features that should route to VERIFY when
 * structural features are also present. The model can't reliably
 * distinguish "assumed input not visible" from "input pattern
 * visible in callers" — the agent needs to search to confirm.
 */
const SOFT_SPECULATION_FEATURES: (keyof SafeguardFeatureSet)[] = [
    'requires_assumed_input',
    'requires_assumed_workload',
    'is_anti_pattern_only',
];

/**
 * Deterministic triage logic for safeguard feature extraction.
 *
 * Given the boolean features extracted by the LLM, classifies each
 * suggestion into: keep (clear structural defect), discard (clear
 * speculation), or verify (ambiguous — needs agent verification).
 */
export function triageSuggestion(
    features: SafeguardFeatureSet,
): TriageDecision {
    const hasHardDiscard = HARD_DISCARD_FEATURES.some((f) => features[f]);
    const hasSoftSpeculation = SOFT_SPECULATION_FEATURES.some(
        (f) => features[f],
    );
    const hasStructuralDefect = STRUCTURAL_DEFECT_FEATURES.some(
        (f) => features[f],
    );

    // Hard discard: definitive signals → always discard
    if (hasHardDiscard) {
        return 'discard';
    }

    // Soft speculation + structural defect → ambiguous, needs verification
    // The model says "this is a real defect BUT it requires assumed input/workload"
    // The agent should search the codebase to confirm if the input/workload is real
    if (hasSoftSpeculation && hasStructuralDefect) {
        return 'verify';
    }

    // Soft speculation only (no structural defect) → discard
    if (hasSoftSpeculation) {
        return 'discard';
    }

    // Structural defect only → verify (agent confirms if defect is real or mitigated)
    // Eval showed structural features alone don't guarantee the defect is real —
    // it may be mitigated by code elsewhere (callers, wrappers, error handlers)
    if (hasStructuralDefect) {
        return 'verify';
    }

    // No signals at all — model is unsure, needs verification
    return 'verify';
}

/**
 * Maps triage decisions to safeguard actions.
 * 'keep' → 'no_changes' (or 'update' if improvedCode is wrong)
 * 'discard' → 'discard'
 * 'verify' → depends on verification result (default: 'discard')
 */
export function triageToAction(
    decision: TriageDecision,
    improvedCodeIsCorrect: boolean,
): string {
    switch (decision) {
        case 'keep':
            return improvedCodeIsCorrect ? 'no_changes' : 'update';
        case 'discard':
            return 'discard';
        case 'verify':
            // Default to discard for unverified — safe default
            return 'discard';
    }
}
