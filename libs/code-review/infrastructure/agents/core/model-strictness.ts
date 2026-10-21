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
    // A/B: o comentario acima mede strict CRATERANDO recall no Claude
    // (0.357 -> 0.100). O Gemini roda com strict LIGADO e pontua 11.6% no
    // finder-recall — mesma ordem do Claude degradado. RECALL_NO_STRICT=1
    // desliga para medir se a causa e a mesma.
    if (process.env.RECALL_NO_STRICT === '1') return false;
    return /^gemini[-_]/i.test(modelId);
}

/**
 * Strict decision for a RUN that may fail over from `primary` to `fallback`.
 *
 * The done-tool's `strict` flag is baked into the agent spec ONCE, but a runtime
 * failover (runWithModelFailover) can swap the model mid-flight. Strict is only
 * safe if EVERY model that could actually run the call accepts it — a strict tool
 * built for a Gemini primary and then sent to an OpenAI fallback is rejected up
 * front ("Invalid schema for function ...", every property must be `required`).
 * So enable strict only when the primary supports it AND there is no fallback the
 * swap could land on that doesn't. Losing strict on the primary is a cheap
 * validation cost; a fallback that can't run at all is a broken failover.
 */
export function supportsStrictToolsForRun(
    primaryModelId: string | undefined,
    fallbackModelId?: string | undefined,
): boolean {
    if (!supportsStrictTools(primaryModelId)) return false;
    if (fallbackModelId && !supportsStrictTools(fallbackModelId)) return false;
    return true;
}
