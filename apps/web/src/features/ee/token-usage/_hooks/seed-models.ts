/**
 * Resolves the initial model selection for the Costs screen from the `?models=`
 * deep-link param (e.g. produced by the BYOK per-model cost chip).
 *
 * Rules (see .planning/features/1395-byok-cost/PLAN.md, T3):
 * - No param → select all available models ("All models").
 * - Comma-separated ids, intersected with the available models so a stale or
 *   unknown id can't select a model that isn't in the current aggregation.
 * - If nothing valid survives the intersection → fall back to all (never an
 *   empty selection, which the UI also reads as "All models").
 */
export function seedSelectedModels(
    raw: string | null | undefined,
    available: readonly string[],
): string[] {
    if (!raw) return [...available];
    // O(1) membership per candidate instead of scanning `available` each pass.
    const availableSet = new Set(available);
    const wanted = raw
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
    const valid = wanted.filter((m) => availableSet.has(m));
    return valid.length ? valid : [...available];
}
