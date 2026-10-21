/**
 * Canonical model id — the ONE normalization the token-usage write path, the
 * pricing read path, and the BYOK per-model cost join all key on, so a model's
 * spend rolls up to a single stable bucket that matches the configured id.
 *
 * Two things get stripped, and ONLY these two:
 *   1. A trailing `:<digits>` VERSION suffix. Amazon Bedrock inference-profile ids
 *      look like `us.anthropic.claude-3-5-haiku-20241022-v1:0` — the `:0` is a
 *      version, not part of the model. A naive `split(':').pop()` returns `"0"`,
 *      which (a) never matches the configured id and (b) collapses EVERY Bedrock
 *      model onto the same `"0"` bucket. Strip the version instead.
 *   2. A leading `provider:` PREFIX. Our own `provider:model` labels
 *      (`anthropic:claude-opus-5`) carry the transport up front; the identity is
 *      the part after it.
 *
 * A `provider/model` SLASH prefix (`vertex_ai/gemini-2.5-pro`) is preserved here —
 * the read path emits both this and the bare last segment (see canonicalNames), so
 * do not collapse slashes in this shared primitive.
 *
 * Mirrored verbatim in apps/web (`_data`/usage) because apps/web can't import a
 * value from `@libs/*` without breaking the isolated prod build — keep the two in
 * lockstep.
 */
export function canonicalModelId(model: string | null | undefined): string {
    const stripped = (model ?? '').trim().replace(/:\d+$/, '');
    return (stripped.split(':').pop() ?? '').trim();
}
