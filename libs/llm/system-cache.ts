/**
 * System-prompt cache hint — the `providerOptions` to attach to the system
 * message so a multi-step agent loop reads the (long, static) system prompt from
 * cache instead of re-billing it every step. A large cost/latency win on cache
 * hits (Anthropic-family models).
 *
 * The SHAPE is provider-specific and lives in the provider module
 * (`module.systemCacheControl()`), sibling to `module.reasoning()` — only the
 * module knows its protocol. This helper is the thin registry delegator: given
 * the resolved slot's `{ provider, model }` it asks the right module, so a Claude
 * served via OpenRouter (openrouter module → no hint) is handled correctly, unlike
 * a model-name regex that would wrongly emit the anthropic namespace.
 *
 * Fallback: when the provider is unknown (the managed / env-default path has no
 * slot), best-effort by model name — a `claude`/`anthropic` id means the anthropic
 * protocol, so reuse the anthropic module's hint (single source of the shape).
 */
import { REGISTRY } from '@libs/llm/providers';
import type { ProviderBuildConfig } from '@libs/llm/providers/kernel/types';
import { isAnthropicModel } from '@libs/llm/providers/kernel/anthropic-cache';

export interface SystemCacheControlInput {
    /** Resolved slot provider — drives the registry lookup (protocol-aware). */
    provider?: string;
    /** Model id/name, as a bare string or a built LanguageModel (`.modelId`).
     *  Used for the module lookup and for the no-provider regex fallback. */
    model?: string | { modelId?: string };
}

function modelIdOf(model: SystemCacheControlInput['model']): string {
    if (typeof model === 'string') return model;
    return model?.modelId ?? '';
}

function anthropicHint(modelId: string): Record<string, unknown> | undefined {
    // Reuse the anthropic module's hint so the SHAPE has a single source.
    return REGISTRY.has('anthropic')
        ? REGISTRY.get('anthropic').systemCacheControl?.({
              provider: 'anthropic',
              model: modelId,
              apiKey: '',
          } as ProviderBuildConfig)
        : undefined;
}

/**
 * Resolve the system-prompt cache `providerOptions` for a slot, or `undefined`
 * when the model doesn't want an inline hint (non-Anthropic, or unknown).
 */
export function systemCacheControl(
    input: SystemCacheControlInput,
): Record<string, unknown> | undefined {
    const modelId = modelIdOf(input.model);

    // Provider known → the module owns the protocol + the hint shape.
    if (input.provider && REGISTRY.has(input.provider)) {
        return REGISTRY.get(input.provider).systemCacheControl?.({
            provider: input.provider,
            model: modelId,
            apiKey: '',
        } as ProviderBuildConfig);
    }

    // Provider unknown (managed/env default, no slot) → best-effort by name.
    return isAnthropicModel(modelId) ? anthropicHint(modelId) : undefined;
}
