/**
 * Prompt cache for ONE-SHOT calls that share a prefix.
 *
 * `applyCacheBreakpoints` (prompt-cache.ts) caches only multi-step loops: one
 * isolated call re-reads nothing, so a write premium never pays back. A batch
 * of one-shot calls is different when its calls open with the same text — the
 * Kody Rules shards of a review all start with the same rules head. The caller
 * that knows that declares it (`promptCache`), and this module turns the
 * declaration into the provider's marker. A call that declares nothing is sent
 * exactly as before.
 */
import type { ModelMessage, SystemModelMessage } from 'ai';
import { REGISTRY } from '@libs/llm/providers';
import type {
    PrefixCacheHint,
    ProviderBuildConfig,
} from '@libs/llm/providers/kernel/types';
import { systemCacheControl } from './system-cache';

export type { PrefixCacheHint };

/** What a one-shot call declares it shares with sibling calls. */
export interface OneShotPromptCache {
    /** The system prompt is the same on every sibling call. */
    system?: boolean;
    /** The user turn starts with this text on every sibling call. */
    userPrefix?: string;
}

export interface PrefixCacheHintInput {
    provider?: string;
    model?: string;
    baseURL?: string;
}

/** The provider's marker for a shared one-shot prefix, or undefined when the
 *  model caches implicitly, cannot cache, or is unknown. */
export function resolvePrefixCacheHint(
    input: PrefixCacheHintInput,
): PrefixCacheHint | undefined {
    const { provider, model = '', baseURL } = input;
    if (provider && REGISTRY.has(provider)) {
        const mod = REGISTRY.get(provider);
        const cfg = {
            provider,
            model,
            baseURL,
            apiKey: '',
        } as ProviderBuildConfig;
        if (mod.prefixCacheHint) return mod.prefixCacheHint(cfg);
        const part = mod.systemCacheControl?.(cfg);
        return part ? { part } : undefined;
    }
    const part = systemCacheControl({ provider, model });
    return part ? { part } : undefined;
}

type ProviderOptions = Record<string, unknown>;

export interface OneShotCacheInput {
    system?: string;
    /** The user turn exactly as it will be sent. */
    prompt: string;
    cache?: OneShotPromptCache;
    hint: PrefixCacheHint | undefined;
    providerOptions?: ProviderOptions;
}

export interface OneShotCacheResult {
    /** generateText arguments: `{ system, prompt }` untouched, or the marked
     *  `system` message and/or a `messages` array in place of `prompt`. */
    args: {
        system?: string | SystemModelMessage;
        prompt?: string;
        messages?: Array<ModelMessage & { role: 'user' }>;
    };
    providerOptions?: ProviderOptions;
    /** Which parts carry a marker. */
    marked: Array<'system' | 'userPrefix'>;
    /** Why a declared prefix got no marker. */
    skipped?: 'prefix-mismatch';
    /** The call options carried an automatic Anthropic cacheControl, which
     *  would also write the call's unique tail; it was removed. */
    droppedAutoCache: boolean;
}

function withRequestOptions(
    providerOptions: ProviderOptions | undefined,
    request: PrefixCacheHint['request'],
): ProviderOptions | undefined {
    if (!request) return providerOptions;
    const merged: ProviderOptions = { ...(providerOptions ?? {}) };
    for (const [vendor, options] of Object.entries(request)) {
        const existing = merged[vendor];
        merged[vendor] = {
            ...(existing && typeof existing === 'object' ? existing : {}),
            ...options,
        };
    }
    return merged;
}

/** Remove a request-level (automatic) Anthropic cache marker. On a call with
 *  its own breakpoint it would only add a write of the call's unique tail. */
function withoutAutomaticCache(providerOptions: ProviderOptions | undefined): {
    providerOptions: ProviderOptions | undefined;
    dropped: boolean;
} {
    const anthropic = providerOptions?.anthropic;
    if (!anthropic || typeof anthropic !== 'object') {
        return { providerOptions, dropped: false };
    }
    const { cacheControl, cache_control, ...rest } = anthropic as Record<
        string,
        unknown
    >;
    if (cacheControl === undefined && cache_control === undefined) {
        return { providerOptions, dropped: false };
    }
    return {
        providerOptions: { ...providerOptions, anthropic: rest },
        dropped: true,
    };
}

export function applyOneShotCache(
    input: OneShotCacheInput,
): OneShotCacheResult {
    const { system, prompt, cache, hint, providerOptions } = input;
    const untouched: OneShotCacheResult = {
        args: { system, prompt },
        providerOptions,
        marked: [],
        droppedAutoCache: false,
    };
    if (!cache || !hint) return untouched;

    const marked: OneShotCacheResult['marked'] = [];
    let skipped: OneShotCacheResult['skipped'];

    const markSystem = !!cache.system && !!system;
    if (markSystem) marked.push('system');

    const prefix = cache.userPrefix;
    let messages: OneShotCacheResult['args']['messages'];
    if (prefix) {
        if (prompt.startsWith(prefix)) {
            const rest = prompt.slice(prefix.length);
            messages = [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: prefix,
                            providerOptions: hint.part,
                        },
                        ...(rest
                            ? [{ type: 'text' as const, text: rest }]
                            : []),
                    ],
                } as ModelMessage & { role: 'user' },
            ];
            marked.push('userPrefix');
        } else {
            skipped = 'prefix-mismatch';
        }
    }

    if (!marked.length)
        return { ...untouched, ...(skipped ? { skipped } : {}) };

    const cleaned = withoutAutomaticCache(providerOptions);
    return {
        args: {
            system: markSystem
                ? ({
                      role: 'system',
                      content: system!,
                      providerOptions: hint.part,
                  } as SystemModelMessage)
                : system,
            ...(messages ? { messages } : { prompt }),
        },
        providerOptions: withRequestOptions(
            cleaned.providerOptions,
            hint.request,
        ),
        marked,
        ...(skipped ? { skipped } : {}),
        droppedAutoCache: cleaned.dropped,
    };
}
