/**
 * The CLI's thinking and effort, from the providerOptions the AI SDK call would
 * have sent — the slot's own, or the caller's override (the finder's
 * config-derived reasoning). Same input, same reasoning, either runtime.
 *
 * The CLI defaults to adaptive thinking at medium effort; an empty
 * providerOptions means the AI SDK path sends no thinking at all, so that
 * becomes thinking disabled here.
 */
export type CliEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface CliReasoning {
    thinking: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' };
    effort?: CliEffort;
}

const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const effortOf = (v: unknown): CliEffort | undefined => (typeof v === 'string' && EFFORTS.has(v) ? (v as CliEffort) : undefined);

export function cliReasoning(providerOptions: Record<string, unknown> | undefined): CliReasoning {
    const anthropic = providerOptions?.anthropic as { thinking?: { type?: string; budgetTokens?: number }; effort?: string } | undefined;
    if (anthropic?.thinking?.type === 'adaptive') {
        const effort = effortOf(anthropic.effort);
        return { thinking: { type: 'adaptive' }, ...(effort ? { effort } : {}) };
    }
    if (anthropic?.thinking?.type === 'enabled') {
        return { thinking: { type: 'enabled', ...(anthropic.thinking.budgetTokens ? { budgetTokens: anthropic.thinking.budgetTokens } : {}) } };
    }
    if (anthropic?.thinking?.type === 'disabled') return { thinking: { type: 'disabled' } };

    const bedrock = (providerOptions?.amazonBedrock as { reasoningConfig?: { type?: string; maxReasoningEffort?: string; budgetTokens?: number } } | undefined)?.reasoningConfig;
    if (bedrock?.type === 'adaptive') {
        const effort = effortOf(bedrock.maxReasoningEffort);
        return { thinking: { type: 'adaptive' }, ...(effort ? { effort } : {}) };
    }
    if (bedrock?.type === 'enabled') return { thinking: { type: 'enabled', ...(bedrock.budgetTokens ? { budgetTokens: bedrock.budgetTokens } : {}) } };

    const openrouter = (providerOptions?.openrouter as { reasoning?: { effort?: string } } | undefined)?.reasoning;
    const orEffort = effortOf(openrouter?.effort);
    if (orEffort) return { thinking: { type: 'adaptive' }, effort: orEffort };

    return { thinking: { type: 'disabled' } };
}
