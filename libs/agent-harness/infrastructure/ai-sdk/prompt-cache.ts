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
 * stamps an OPAQUE `providerOptions` object onto the two breakpoints the harness
 * owns (the runner already marks the third, the system prompt). WHICH hint (or
 * none) is a provider decision made upstream in `libs/llm` (the registry returns
 * the Anthropic `cacheControl: ephemeral` object for providers that honor inline
 * markers, `undefined` for the implicit-cache ones — OpenAI/Gemini/Azure — where
 * marking is a no-op). The harness never names a vendor; it only propagates the
 * object it is handed.
 *
 * Placement mirrors what production tool-use harnesses converge on: last tool +
 * last system part + latest user message (3 of Anthropic's 4 breakpoints, one to
 * spare). The system part is handled in the runner; this file does tools + the
 * latest user message.
 */
import type { ModelMessage } from 'ai';

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
    if (keys.length === 0) return tools;
    const lastKey = keys[keys.length - 1];
    const lastTool = tools[lastKey];
    if (!lastTool || typeof lastTool !== 'object') return tools;
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
        if (messages[i].role !== 'user') continue;
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
