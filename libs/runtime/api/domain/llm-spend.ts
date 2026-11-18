// The Runtime's LLM spend as the product records it: the usage span LLM.run
// writes for every call (observability_telemetry, the source Token Usage
// reads), never the gateway's budget counters (those are for limits only).
// Each span is priced by the product's price list at the tier its prompt fell
// in (a Claude or Gemini prompt above 200K at that tier's rate), with the
// org's manual price overrides, exactly as Token Usage prices it.

/** Who spent the tokens (docs/runtime/usage-report.md). */
export const RUNTIME_LLM_AGENTS = ['recipe_author', 'planner', 'run_agent', 'intent', 'setup_learn', 'other'] as const;
export type RuntimeLlmAgent = (typeof RUNTIME_LLM_AGENTS)[number];

/** Who pays the provider: Kodus (managed models) or the org (its BYOK key). */
export type LlmPaidBy = 'kodus' | 'customer';

/** One priced bucket of spans: a Run (or setup scope), the agent, where, the model, who pays. */
export interface RuntimeLlmSpendRow {
    /** The Run's id, the setup's learn scope for the recipe author, null on a span that carries none. */
    runId: string | null;
    agent: RuntimeLlmAgent;
    repositoryId: string | null;
    environmentId: string | null;
    /** The model that answered ('' when the span named none). */
    model: string;
    paidBy: LlmPaidBy;
    /** Cache tokens are part of inputTokens (ai@7). */
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    /** Tokens of calls whose prompt fell above the model's first tier threshold (priced at that tier). */
    aboveBaseTierTokens: number;
    /** Null when the price list (and the org's overrides) cannot price the model. */
    usd: number | null;
}

/**
 * Which agent a span belongs to, from what the caller stamped on it:
 *  - the recipe author (setup): agentName RuntimeRecipeAuthor, task runtime.recipe_author;
 *  - the product's test planner (ADR-069): agentName RuntimeTestPlanner;
 *  - the Run agent in the worker: the gateway's runtime.plan calls and its model turns (runtime.plan.model-turn);
 *  - the finding-intent label (runtime.intent) and the setup's learn loop (runtime.setup_learn).
 */
export function runtimeLlmAgentOf(span: { agentName?: string; task?: string; runName?: string }): RuntimeLlmAgent {
    const { agentName, task, runName } = span;
    if (agentName === 'RuntimeRecipeAuthor' || task === 'runtime.recipe_author' || runName === 'runtime.recipe_author') return 'recipe_author';
    if (agentName === 'RuntimeTestPlanner') return 'planner';
    if (task === 'runtime.setup_learn' || runName === 'runtime.setup_learn') return 'setup_learn';
    if (task === 'runtime.intent' || runName === 'runtime.intent') return 'intent';
    if (task === 'runtime.plan' || runName?.startsWith('runtime.plan')) return 'run_agent';
    return 'other';
}

export interface LlmSpendTotals {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    aboveBaseTierTokens: number;
    /** Sum of the priced rows. A lower bound while unpricedTokens is above zero. */
    pricedUsd: number;
    /** Null when some tokens could not be priced. */
    usd: number | null;
    /** What Kodus pays (managed models) and what the org pays its provider (BYOK), of the priced rows. */
    kodusUsd: number;
    customerUsd: number;
    unpricedTokens: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Sums rows; the US$ is null as soon as one row with tokens has no price, never a zero for it. */
export function sumLlmSpend(rows: readonly RuntimeLlmSpendRow[]): LlmSpendTotals {
    const t = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, aboveBaseTierTokens: 0, pricedUsd: 0, kodusUsd: 0, customerUsd: 0, unpricedTokens: 0 };
    for (const r of rows) {
        t.inputTokens += r.inputTokens;
        t.outputTokens += r.outputTokens;
        t.cacheReadTokens += r.cacheReadTokens;
        t.cacheWriteTokens += r.cacheWriteTokens;
        t.totalTokens += r.totalTokens;
        t.aboveBaseTierTokens += r.aboveBaseTierTokens;
        if (r.usd === null) {
            t.unpricedTokens += r.totalTokens;
            continue;
        }
        t.pricedUsd += r.usd;
        if (r.paidBy === 'customer') t.customerUsd += r.usd;
        else t.kodusUsd += r.usd;
    }
    return {
        ...t,
        pricedUsd: round6(t.pricedUsd),
        kodusUsd: round6(t.kodusUsd),
        customerUsd: round6(t.customerUsd),
        usd: t.unpricedTokens > 0 ? null : round6(t.pricedUsd),
    };
}
