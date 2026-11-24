/**
 * The reasoning budget some adapters send on top of the answer cap. Shared by
 * the BYOK wrapper (the tokens-per-minute admission) and by callers that must
 * fit a request in the model's window: both have to count what the provider
 * really receives as `max_tokens`.
 */
import { createAnthropic } from '@ai-sdk/anthropic';

import { REGISTRY } from '@libs/llm/providers/kernel/registry';
import { reasoningBudgetFrom } from '@libs/llm/reasoning-budget';

/** What the lookups read: the env-managed descriptor has no more than this. */
type SlotModel = { provider: string; model: string };

/**
 * Adapters that send max_tokens = answer cap + reasoning budget, read in
 * their source: @ai-sdk/anthropic (`maxTokens + thinkingBudget`) and
 * @ai-sdk/amazon-bedrock (`maxTokens += thinkingBudget`). Others hold the
 * reasoning inside the answer cap (OpenAI, Gemini).
 */
const ADDS_BUDGET_TO_ANSWER_CAP = new Set(['anthropic', 'amazonBedrock']);

/**
 * The reasoning budget a request adds on top of its answer cap: read only from
 * the options the served adapter parses, and only for an adapter that adds it.
 * An adapter parses its own key, or else a legacy alias (Bedrock's `bedrock`),
 * so the first of them present is the one sent.
 */
export function budgetAddedToAnswerCap(
    providerOptions: Record<string, unknown> | undefined,
    slot: SlotModel | undefined,
    namespace: string | undefined,
): number | undefined {
    if (!namespace || !ADDS_BUDGET_TO_ANSWER_CAP.has(namespace)) {
        return undefined;
    }
    const aliases =
        REGISTRY.get(slot!.provider).providerOptionsNamespaceAliases?.(
            slot!.provider,
        ) ?? [];
    const parsed = [namespace, ...aliases].find(
        (key) => providerOptions?.[key] != null,
    );
    if (!parsed) {
        return undefined;
    }
    const options = providerOptions![parsed] as Record<string, unknown>;
    const budget = reasoningBudgetFrom(options);
    if (budget !== undefined) {
        return budget;
    }
    // Thinking enabled with no budget: @ai-sdk/anthropic sends its default
    // budget, 1024, on top of the answer cap all the same.
    const thinking = (options as { thinking?: { type?: unknown } }).thinking;
    return namespace === 'anthropic' && thinking?.type === 'enabled'
        ? ANTHROPIC_DEFAULT_THINKING_BUDGET
        : undefined;
}

/** What @ai-sdk/anthropic budgets for thinking enabled without a budget. */
const ANTHROPIC_DEFAULT_THINKING_BUDGET = 1024;

/** The provider-options key the slot's adapter reads, so an effort the call
 *  never carried can be added there when the upstream asks for it. */
export function optionsNamespace(
    slot: SlotModel | undefined,
): string | undefined {
    if (!slot?.provider || !REGISTRY.has(slot.provider)) return undefined;
    return REGISTRY.get(slot.provider).providerOptionsNamespace?.(
        slot.provider,
        slot.model,
    );
}

/**
 * The `max_tokens` @ai-sdk/anthropic declares for this answer and these
 * options, asked of the adapter itself: it adds the thinking budget, and caps
 * the sum at a known Claude model's output limit (64k for Sonnet 4.5), which
 * a copy of its table would drift from. No request leaves: the fetch takes
 * the body and stops. Undefined when the adapter could not tell.
 */
export async function anthropicDeclaredMaxTokens(
    modelId: string,
    maxOutputTokens: number,
    providerOptions: Record<string, unknown> | undefined,
): Promise<number | undefined> {
    const key = `${modelId}|${maxOutputTokens}|${JSON.stringify(providerOptions ?? {})}`;
    if (declared.has(key)) {
        return declared.get(key);
    }
    let sent: number | undefined;
    const adapter = createAnthropic({
        apiKey: 'declared-max-tokens',
        fetch: (async (_url: unknown, init?: { body?: unknown }) => {
            const body = JSON.parse(String(init?.body ?? '{}'));
            sent =
                typeof body.max_tokens === 'number'
                    ? body.max_tokens
                    : undefined;
            throw new Error('declared max_tokens read; nothing is sent');
        }) as typeof fetch,
    });
    try {
        await adapter(modelId).doGenerate({
            prompt: [{ role: 'user', content: [{ type: 'text', text: '.' }] }],
            maxOutputTokens,
            providerOptions: providerOptions as any,
        });
    } catch {
        // The fetch above always stops the call.
    }
    if (declared.size >= DECLARED_MAX_ENTRIES) {
        declared.delete(declared.keys().next().value as string);
    }
    declared.set(key, sent);
    return sent;
}

/** One entry per model, answer and options: a worker sees few of them. */
const DECLARED_MAX_ENTRIES = 256;
const declared = new Map<string, number | undefined>();
