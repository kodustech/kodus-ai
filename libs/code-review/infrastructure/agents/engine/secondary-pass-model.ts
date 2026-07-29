import { createOpenAI } from '@ai-sdk/openai';
import {
    buildModelFromSlot,
    getInternalModel,
} from '@libs/llm/byok-to-vercel';
import type { BYOKConfig } from '@kodus/kodus-common/llm';

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

function platformSecondaryModel(): any | null {
    const openaiKey = process.env.API_OPEN_AI_API_KEY;
    if (!openaiKey) return null;
    return createOpenAI({
        apiKey: openaiKey,
        ...(process.env.API_OPENAI_FORCE_BASE_URL
            ? { baseURL: process.env.API_OPENAI_FORCE_BASE_URL }
            : {}),
    })(SECONDARY_PASS_MODEL_ID);
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

    const platform = platformSecondaryModel();
    if (platform) return platform;

    return getInternalModel(byokConfig?.main);
}
