// LLM budget of the Runtime gateway (ADR-057, §11): per Run, per PR and per
// org per day. The Run limit is the lower of the gateway's and the ceiling the
// product signed into the Run token.

export interface RuntimeLlmBudgetLimits {
    perRun: number;
    perPullRequest: number;
    perOrgPerDay: number;
}

export interface RuntimeLlmSpend {
    run: number;
    pullRequest: number;
    orgToday: number;
}

export type BudgetScope = 'run' | 'pull_request' | 'org_day';

export type BudgetDecision =
    | { allowed: true; remaining: number }
    | { allowed: false; exhausted: BudgetScope; spent: number; limit: number };

/** The three scopes as [scope, spent, limit]; the Run limit is the lower of the gateway's and the token's ceiling. */
function budgetScopes(spend: RuntimeLlmSpend, limits: RuntimeLlmBudgetLimits, runCeiling?: number): Array<[BudgetScope, number, number]> {
    const runLimit = runCeiling && runCeiling > 0 ? Math.min(runCeiling, limits.perRun) : limits.perRun;
    return [
        ['run', spend.run, runLimit],
        ['pull_request', spend.pullRequest, limits.perPullRequest],
        ['org_day', spend.orgToday, limits.perOrgPerDay],
    ];
}

/** The scope with the least left, as a refusal names it: the one that stops the call. */
export function tightestBudgetScope(spend: RuntimeLlmSpend, limits: RuntimeLlmBudgetLimits, runCeiling?: number): { exhausted: BudgetScope; spent: number; limit: number } {
    const [exhausted, spent, limit] = budgetScopes(spend, limits, runCeiling).reduce((a, b) => (b[2] - b[1] < a[2] - a[1] ? b : a));
    return { exhausted, spent, limit };
}

export function decideBudget(spend: RuntimeLlmSpend, limits: RuntimeLlmBudgetLimits, runCeiling?: number): BudgetDecision {
    const checks = budgetScopes(spend, limits, runCeiling);
    for (const [scope, spent, limit] of checks) {
        if (spent >= limit) return { allowed: false, exhausted: scope, spent, limit };
    }
    return { allowed: true, remaining: Math.min(...checks.map(([, spent, limit]) => limit - spent)) };
}

/** Output tokens a call may use when the worker does not ask for a number. */
export const DEFAULT_OUTPUT_TOKENS = 8_192;

/** Rough, conservative tokens of a prompt: 3 chars per token (most tokenizers do ~4). */
export const estimateInputTokens = (chars: number) => Math.ceil(chars / 3);

export type CallPlan =
    | { allowed: true; reserve: number; maxOutputTokens: number; remaining: number }
    | { allowed: false; exhausted: BudgetScope; spent: number; limit: number };

/**
 * What one call may reserve: its estimated input plus an output cap that fits
 * what is left in the tightest scope. A prompt bigger than what is left is
 * refused before the provider is called; the provider never gets an
 * unbounded output.
 */
export function planLlmCall(
    spend: RuntimeLlmSpend,
    limits: RuntimeLlmBudgetLimits,
    input: { runCeiling?: number; inputTokens: number; requestedOutputTokens?: number },
): CallPlan {
    const decision = decideBudget(spend, limits, input.runCeiling);
    if (decision.allowed === false) return decision;
    const maxOutputTokens = Math.min(input.requestedOutputTokens ?? DEFAULT_OUTPUT_TOKENS, decision.remaining - input.inputTokens);
    if (maxOutputTokens < 1) return { allowed: false, ...tightestBudgetScope(spend, limits, input.runCeiling) };
    return { allowed: true, reserve: input.inputTokens + maxOutputTokens, maxOutputTokens, remaining: decision.remaining };
}

/** @deprecated use planLlmCall. */
export const planCall = planLlmCall;

/** The org's own daily budget (Settings) can only lower the gateway's. */
export function withOrgBudget(limits: RuntimeLlmBudgetLimits, tokenBudgetPerDay: number | null | undefined): RuntimeLlmBudgetLimits {
    return tokenBudgetPerDay && tokenBudgetPerDay > 0
        ? { ...limits, perOrgPerDay: Math.min(limits.perOrgPerDay, tokenBudgetPerDay) }
        : limits;
}

/**
 * The limits a setup's calls (Kody's learn loop, the recipe author) are
 * decided on. A setup is no pull request: its tokens are counted under
 * prNumber 0 of the repository, a counter every setup of the repository
 * shares and that never expires, so a per-PR limit there would lock the
 * repository out of Kody's setup help for good once a few setups reached it.
 * The setup's own scope (the ceiling its token carries) and the org's day
 * bound a setup instead.
 */
export function setupBudgetLimits(limits: RuntimeLlmBudgetLimits): RuntimeLlmBudgetLimits {
    return { ...limits, perPullRequest: Number.MAX_SAFE_INTEGER };
}

/** Start of the UTC day of `now`; the per-day budget resets at 00:00 UTC. */
export function startOfUtcDay(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
