/**
 * Vendor wire spellings a user pastes into the reasoning override, renamed to
 * the option the AI SDK adapter reads (see `normalizeReasoningOverride` in
 * `types.ts`). Each adapter strips the wire spelling and renders the same field
 * from its own option, so the rename is what lets the pasted value through.
 *
 * Production 2026-10-01: two deepseek-v4 slots paste `reasoning_effort: "max"`
 * and one Claude slot pastes `output_config: { effort: "high" }`, the spellings
 * those vendors' API docs show. All three values were dropped before the wire.
 */

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

/** `reasoning_effort` → `reasoningEffort`, which `@ai-sdk/openai` and
 *  `@ai-sdk/openai-compatible` render as the `reasoning_effort` body field. */
export function reasoningEffortFromWire(
    options: Record<string, unknown>,
): Record<string, unknown> {
    if (!('reasoning_effort' in options)) return options;
    const { reasoning_effort, ...rest } = options;
    // The adapter's own name wins when the user gave both.
    if (rest.reasoningEffort !== undefined) return options;
    return { ...rest, reasoningEffort: reasoning_effort };
}

/** `output_config.effort` → `effort`, which `@ai-sdk/anthropic` renders as
 *  `output_config.effort`. Anything else inside `output_config` is left as it
 *  was pasted. */
export function effortFromOutputConfig(
    options: Record<string, unknown>,
): Record<string, unknown> {
    const config = options.output_config;
    if (!isPlainObject(config) || config.effort === undefined) return options;
    if (options.effort !== undefined) return options;
    const { effort, ...otherConfig } = config;
    const { output_config: _dropped, ...rest } = options;
    return {
        ...rest,
        effort,
        ...(Object.keys(otherConfig).length
            ? { output_config: otherConfig }
            : {}),
    };
}
