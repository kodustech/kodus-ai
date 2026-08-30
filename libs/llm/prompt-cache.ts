/**
 * Prompt-cache breakpoints for a multi-step agent loop.
 *
 * An agentic turn (finder, conversation, fetcher) is ONE user task that explodes
 * into many model calls — one per step. Every call re-sends the same stable
 * prefix: the tools block (immutable) and the conversation up to the task
 * prompt. Marking cache breakpoints on that prefix lets each intra-turn call
 * read it from cache instead of re-billing it.
 *
 * This module is the generic, vendor-agnostic APPLICATION of a cache hint — it
 * stamps an OPAQUE `providerOptions` object onto the breakpoints that fan out
 * across the loop. WHICH hint (or none) is a provider decision
 * (`systemCacheControl` in `system-cache.ts` returns the Anthropic
 * `cacheControl: ephemeral` object for providers that honor inline markers,
 * `undefined` for the implicit-cache ones — OpenAI/Gemini/Azure — where marking
 * is a no-op).
 *
 * Placement mirrors what production tool-use harnesses converge on: last tool +
 * system part + latest user message (3 of Anthropic's 4 breakpoints, one to
 * spare). `applyCacheBreakpoints` is the single entry point that decides the hint
 * and stamps all three; the individual stampers (`markLastToolForCache`,
 * `markLatestUserForCache`) stay exported for direct/unit use.
 *
 * Lives in `@libs/llm` (not the harness) because `LLM.run` owns the model call —
 * it calls `applyCacheBreakpoints` as part of assembling the agent-loop invocation.
 */
import type { ModelMessage } from 'ai';
import { systemCacheControl } from './system-cache';

/** Opaque per-vendor cache marker (e.g. `{ anthropic: { cacheControl: … } }`). */
export type CacheHint = Readonly<Record<string, unknown>>;

/** Shallow-merge `hint` into an existing `providerOptions`, hint winning. A
 *  manual placement the caller already made is preserved for other vendors. */
const mergeProviderOptions = (
    existing: Record<string, unknown> | undefined,
    hint: CacheHint,
): Record<string, unknown> => ({ ...(existing ?? {}), ...hint });

/**
 * Stamp `hint` as `providerOptions` on the LAST tool in the map. Anthropic caches
 * the tools block up to and including a marked tool, so one breakpoint on the
 * last tool caches the whole (order-stable) block. Idempotent and pure: returns
 * a new map with the last entry replaced, or the same reference when there are no
 * tools or the mark is already present.
 */
export function markLastToolForCache<T extends Record<string, any>>(
    tools: T,
    hint: CacheHint,
): T {
    const keys = Object.keys(tools);
    if (keys.length === 0) {
        return tools;
    }
    const lastKey = keys[keys.length - 1];
    const lastTool = tools[lastKey];
    if (!lastTool || typeof lastTool !== 'object') {
        return tools;
    }
    return {
        ...tools,
        [lastKey]: {
            ...lastTool,
            providerOptions: mergeProviderOptions(
                lastTool.providerOptions,
                hint,
            ),
        },
    };
}

/**
 * Stamp `hint` as message-level `providerOptions` on the latest `user` message.
 * The AI SDK lowers a message-level marker onto that message's last content
 * block, so the conversation prefix up to the task prompt is cached — the
 * boundary that stays fixed while the turn fans out into assistant/tool
 * round-trips. Idempotent and pure: returns a new array with the one message
 * replaced, or the same reference when there is no user message.
 */
export function markLatestUserForCache(
    messages: ModelMessage[],
    hint: CacheHint,
): ModelMessage[] {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'user') {
            continue;
        }
        const target = messages[i];
        const next = messages.slice();
        next[i] = {
            ...target,
            providerOptions: mergeProviderOptions(
                target.providerOptions as Record<string, unknown> | undefined,
                hint,
            ),
        } as ModelMessage;
        return next;
    }
    return messages;
}

/**
 * Apply the whole prompt-cache decision to ONE model call: ask the model's
 * provider whether it honors inline cache markers (`systemCacheControl`), and if
 * so stamp all three breakpoints (system message + latest user message + last
 * tool). This is the single seam the agent-loop invocation uses — the future
 * per-provider cache strategy plugs in HERE, so the wiring is testable in one
 * place instead of inline in `LLM.run`.
 *
 * Two invariants, pinned by spec:
 *   - Cache is applied ONLY in a multi-step loop (`maxSteps > 1`): a single-shot
 *     call re-reads nothing, so the write premium never pays back — return the
 *     inputs untouched (same references).
 *   - When the provider does NOT honor inline markers (OpenAI/Gemini/Azure cache
 *     implicitly, unknown providers), `systemCacheControl` returns undefined and
 *     every breakpoint is a no-op — inputs pass through unchanged.
 */
export function applyCacheBreakpoints<T extends Record<string, any>>(input: {
    /** The system prompt string (may be undefined for a system-less call). */
    system?: string;
    messages: ModelMessage[];
    /** The tools map (`loop.tools`); the last entry anchors the tools-block cache. */
    tools: T;
    /** The loop's hard step ceiling — cache only fans out when > 1. */
    maxSteps: number;
    /** Resolved slot provider (drives the protocol-aware hint decision). */
    provider?: string;
    /** Model id/name or built model (`.modelId`) — for the module lookup and the
     *  no-provider (managed/env default) name fallback. */
    model?: string | { modelId?: string };
}): { systemArg: unknown; callMessages: ModelMessage[]; callTools: T } {
    const cacheHint =
        input.maxSteps > 1
            ? systemCacheControl({
                  provider: input.provider,
                  model: input.model,
              })
            : undefined;

    const systemArg =
        cacheHint && input.system
            ? {
                  role: 'system',
                  content: input.system,
                  providerOptions: cacheHint,
              }
            : input.system;
    const callMessages = cacheHint
        ? markLatestUserForCache(input.messages, cacheHint)
        : input.messages;
    const callTools = cacheHint
        ? markLastToolForCache(input.tools, cacheHint)
        : input.tools;

    return { systemArg, callMessages, callTools };
}
