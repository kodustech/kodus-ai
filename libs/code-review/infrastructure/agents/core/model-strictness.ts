/**
 * Which models get provider-native strict/structured tool calling for the
 * done-tool (submitResult / submitVerdict).
 *
 * Strict tool use constrains the model's sampling to schema-valid tokens, so it
 * cannot omit a required field or emit the payload as prose instead of the
 * structured argument object.
 *
 * - Gemini: strict activates VALIDATED mode (prevents the empty-args
 *   `submitResult({})` bug). This is the pre-refactor behavior; the agent-harness
 *   migration dropped it, so this restores it.
 *
 * Anthropic (Claude) is intentionally NOT enabled: measured on the finder-recall
 * eval, native strict tool use CRATERS recall — the grammar-constrained sampling
 * roughly halves the findings the model produces (recall 0.357 -> 0.100 on a
 * 15-PR A/B, tp 15 -> 4). Format correctness is not worth that loss; the format
 * omission is handled by the harness's text-fallback instead.
 *
 * OpenAI / openai-compatible are also excluded: their Structured Outputs require
 * every property in `required`, so our optional-heavy findings schema would be
 * rejected up front ("Invalid schema for function ...").
 */
export function supportsStrictTools(modelId: string | undefined): boolean {
    if (!modelId) return false;
    return /^gemini[-_]/i.test(modelId);
}
