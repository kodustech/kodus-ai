import {
    buildModelFromSlot,
    buildPlatformModel,
    getInternalModel,
} from '@libs/llm/byok-to-vercel';
import type { BYOKConfig } from '@libs/llm/byok-config';

/**
 * Model for the review's SECONDARY passes (dedup, severity classification,
 * suggestion formatting) — NOT the main finding-generation pass.
 *
 * Prefer the org's BYOK so secondary cost rides the client key. Platform
 * `gpt-5.4-mini` is the trial / no-BYOK model.
 *
 * Fail-soft is the caller's job: null model → skip pass / keep agent values.
 */
export const SECONDARY_PASS_MODEL_ID = 'gpt-5.4-mini';

/** True when secondary should bill the client BYOK key (one resolved slot). */
export function isSecondaryByok(byokConfig?: BYOKConfig | null): boolean {
    return !!byokConfig?.main;
}

/**
 * Resolve the ONE secondary-pass model (no main→fallback branch):
 *   1. Org BYOK resolved slot — when configured
 *   2. Platform OpenAI gpt-5.4-mini — trial / no BYOK
 *   3. getInternalModel — self-hosted env or last resort
 *
 * Returns null when nothing is configured; callers skip the pass gracefully.
 */
export function resolveSecondaryPassModel(byokConfig?: BYOKConfig): any {
    if (isSecondaryByok(byokConfig)) {
        // Secondary matches the model the client configured for review — build
        // from the carrier's resolved main slot (read at this boundary).
        return buildModelFromSlot(byokConfig?.main);
    }

    const platform = buildPlatformModel(SECONDARY_PASS_MODEL_ID);
    if (platform) return platform;

    return getInternalModel(byokConfig?.main);
}
