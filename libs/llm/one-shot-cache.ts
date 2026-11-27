/**
 * Prompt cache for ONE-SHOT calls that share a prefix.
 *
 * `applyCacheBreakpoints` (prompt-cache.ts) caches only multi-step loops: one
 * isolated call re-reads nothing, so a write premium never pays back. A batch
 * of one-shot calls is different when its calls open with the same text — the
 * Kody Rules shards of a review all start with the same rules head. The caller
 * that knows that declares it (`promptCache`), and this module turns the
 * declaration into the provider's marker. A call that declares a cache never
 * keeps an automatic one: its unique tail would be written and never read.
 * A call that declares nothing is sent exactly as before.
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
    /** Texts the user turn starts with, each shared by some sibling calls;
     *  a longer one extends a shorter one. Each gets its own breakpoint. Empty:
     *  nothing to mark, and still no automatic cache. */
    userPrefixes?: string[];
}

/** Anthropic's limit on breakpoints in one request; Bedrock and Vertex
 *  follow it, and OpenAI takes one per reusable prefix. */
const MAX_BREAKPOINTS = 4;

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
    /** How many breakpoints the user turn carries. */
    userBreakpoints: number;
    /** Why a declared prefix got no marker. */
    skipped?: 'prefix-mismatch';
    /** The call options carried an automatic Anthropic cacheControl, which
     *  would also write the call's unique tail; it was removed. */
    droppedAutoCache: boolean;
}

/** The declared prefixes the turn starts with, shortest first, one per
 *  length, at most `max` of them (the longest, which cover the most). */
function prefixesToMark(
    prompt: string,
    declared: string[],
    max: number,
): { prefixes: string[]; mismatch: boolean } {
    const usable = declared.filter((p) => p && prompt.startsWith(p));
    const mismatch = declared.some((p) => p && !prompt.startsWith(p));
    const prefixes = [...new Set(usable)].sort((a, b) => a.length - b.length);
    return {
        prefixes: prefixes.slice(Math.max(0, prefixes.length - max)),
        mismatch,
    };
}

/** The user turn cut at each prefix end; every prefix block carries `part`. */
function splitTurn(
    prompt: string,
    prefixes: string[],
    part: PrefixCacheHint['part'],
): ModelMessage & { role: 'user' } {
    const content: Array<{
        type: 'text';
        text: string;
        providerOptions?: PrefixCacheHint['part'];
    }> = [];
    let at = 0;
    for (const prefix of prefixes) {
        content.push({
            type: 'text',
            text: prompt.slice(at, prefix.length),
            providerOptions: part,
        });
        at = prefix.length;
    }
    if (at < prompt.length) {
        content.push({ type: 'text', text: prompt.slice(at) });
    }
    return { role: 'user', content } as ModelMessage & { role: 'user' };
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
        userBreakpoints: 0,
        droppedAutoCache: false,
    };
    if (!cache || !hint) return untouched;

    const marked: OneShotCacheResult['marked'] = [];

    const markSystem = !!cache.system && !!system;
    if (markSystem) marked.push('system');

    const { prefixes, mismatch } = prefixesToMark(
        prompt,
        cache.userPrefixes ?? [],
        MAX_BREAKPOINTS - (markSystem ? 1 : 0),
    );
    const skipped: OneShotCacheResult['skipped'] = mismatch
        ? 'prefix-mismatch'
        : undefined;
    const messages = prefixes.length
        ? [splitTurn(prompt, prefixes, hint.part)]
        : undefined;
    if (messages) marked.push('userPrefix');

    // Declared, so the caller manages this call's cache: an automatic marker
    // would write the whole unique turn whether or not anything was marked,
    // and the request options (OpenAI's explicit mode) cache only what is.
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
        userBreakpoints: prefixes.length,
        ...(skipped ? { skipped } : {}),
        droppedAutoCache: cleaned.dropped,
    };
}
