/**
 * The Anthropic inline prompt-cache marker.
 *
 * `{ anthropic: { cacheControl: ephemeral } }` is the `providerOptions` shape the
 * Anthropic API honors — and, per the AI SDK docs, the SAME shape the
 * Anthropic-on-Bedrock and Anthropic-on-Vertex adapters honor for Claude models.
 * Keeping ONE constructor means the three Claude paths (native / Bedrock / Vertex)
 * never drift on the marker shape; each module's `systemCacheControl` returns THIS.
 */
import { detectModelFamily } from './model-family';

export const anthropicEphemeralCacheHint = (): Record<string, unknown> => ({
    anthropic: { cacheControl: { type: 'ephemeral' } },
});

/**
 * True for a Claude model id in any of its provider spellings: native
 * `claude-3-5-sonnet…`, Bedrock `us.anthropic.claude-…-v1:0`, Vertex
 * `claude-…@20240620`. Used by the Bedrock/Vertex modules to emit the cache hint
 * ONLY for the Anthropic-family deployments they host (Gemini/Nova/Llama on the
 * same provider cache implicitly, so they must NOT get an inline marker).
 *
 * Delegates to the family detector, because "is this a Claude" is one question.
 * It used to be `/claude|anthropic/i`, and that `|anthropic` matched no case its
 * own doc lists — all three spellings above contain "claude" — while matching
 * ids that are NOT Claude at all: a proxy under an `anthropic/` namespace, a
 * customer endpoint named `my-anthropic-gateway/qwen`. Those are free-text model
 * ids, so they are reachable. A false positive here is not cosmetic: Bedrock
 * would resolve that model's temperature and reasoning through the ANTHROPIC
 * module (withholding a temperature it accepts) and attach a `cacheControl`
 * marker this very comment says it must not get.
 */
export const isAnthropicModel = (model: string): boolean =>
    detectModelFamily(model) === 'anthropic';
