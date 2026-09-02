/**
 * The input-token ceiling for a MANAGED-catalog model id.
 *
 * ONE SOURCE, shared with BYOK. This file used to read
 * `capabilities().maxInputTokens` off the provider registry while the BYOK
 * review path read the LiteLLM mirror — two answers to one question, split by
 * which path the request came down. Its own header claimed to be "the single
 * home for per-model context windows", and it was not:
 *
 *   openai:gpt-5.4              registry undefined   mirror 1,050,000
 *   anthropic:claude-opus-5     registry undefined   mirror 1,000,000
 *   google:gemini-2.5-pro       registry 1,000,000   mirror 1,048,576
 *
 * The registry answered `undefined` for almost everything — it was three
 * hand-typed entries, one of them already stale — so the managed chunker fell
 * back to its caller's 64k default even on models that hold a million tokens.
 *
 * The window is a fact about the MODEL, not about who serves it. A provider
 * module describes transport: how to build the client, how to list models, which
 * namespace the SDK reads. It does not get to define what a model is. So the
 * question is asked of the model layer, once, by both paths.
 *
 * Input is an `LLMModelProvider` enum value (`"<vendor>:<model>"`, e.g.
 * `"google:gemini-2.5-pro"`). Returns `undefined` for a bare BYOK model string
 * (no vendor prefix) or a model the mirror does not know — the caller then falls
 * back to its own default budget. BYOK slots carry their own `maxInputTokens`
 * and never route through here (they pass `overrideMaxTokens`).
 */
import { lookupModelContextWindow } from '@libs/llm/model-context-window';

export function managedModelMaxInputTokens(id?: string): number | undefined {
    if (!id) return undefined;
    const sep = id.indexOf(':');
    if (sep < 0) return undefined; // bare BYOK model string — not a managed id
    // The vendor prefix is OURS, not the model's; the mirror is keyed by the
    // vendor's own id. `normalize()` inside the lookup strips a `provider/`
    // form, but not our `vendor:` one, so it comes off here.
    return lookupModelContextWindow(id.slice(sep + 1));
}
