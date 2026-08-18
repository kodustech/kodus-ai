import { getInternalModel } from '@libs/llm/byok-to-vercel';
import type { NormalizedModel } from '@libs/llm/byok-config';

/**
 * Model for the review's SECONDARY passes (dedup, severity classification,
 * suggestion formatting) — NOT the main finding-generation pass.
 *
 * ONE resolution, shared with every other path via `getInternalModel`:
 *   - Org BYOK slot → the client key (secondary cost rides the client key).
 *   - No BYOK → the Kodus-funded default (DeepSeek) or the self-hosted env
 *     model. The Kodus-funded model is ALWAYS DeepSeek — never gpt/gemini.
 *
 * Fail-soft is the caller's job: null model → skip pass / keep agent values.
 */

/** True when secondary should bill the client BYOK key (one resolved slot). */
export function isSecondaryByok(
    byokConfig?: NormalizedModel | undefined,
): boolean {
    return !!byokConfig;
}

/**
 * Resolve the ONE secondary-pass model. Delegates to `getInternalModel` so the
 * BYOK-vs-managed decision, the DeepSeek default and the self-hosted env model
 * all live in the single shared resolver. Returns null when nothing is
 * configured; callers skip the pass gracefully.
 */
export function resolveSecondaryPassModel(
    byokConfig?: NormalizedModel,
): any {
    return getInternalModel(byokConfig);
}
