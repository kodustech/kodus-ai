/**
 * Canonical effort → thinking-budget mapping, in ONE place.
 *
 * It used to exist four times: exported from `reasoning-options.ts` and copied
 * verbatim into the gemini, anthropic and vertex modules. The copies were not
 * carelessness — `reasoning-options.ts` imports `REGISTRY`, so a provider module
 * importing from it would close a cycle (reasoning-options → REGISTRY → modules
 * → reasoning-options). The right answer was to move the constant DOWN to a leaf
 * both sides can depend on, not sideways.
 *
 * All four copies agreed when they were found, so nothing was broken yet — but
 * nothing enforced it either, and the Gemini consumer has since grown a
 * per-model clamp the others do not have. A shared number that four files must
 * keep in step is a drift waiting for its first divergent edit.
 *
 * Deliberately a dependency-free leaf: it imports a TYPE and nothing else.
 */
import type { ReasoningEffort } from './types';

export const EFFORT_TO_BUDGET: Record<ReasoningEffort, number> = {
    none: 0,
    low: 5_000,
    medium: 15_000,
    high: 40_000,
};
