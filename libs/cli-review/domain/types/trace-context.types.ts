import { CliSessionClassifiedDecision } from './cli-session-capture.types';

/**
 * A decision as it appears in the review context pack.
 */
export interface TraceContextDecision extends CliSessionClassifiedDecision {
    /** Repo-relative paths (or directory prefixes) the decision applies to. */
    scope?: string[];
    /** Human correction: pinned decisions are never dropped by the budget cut. */
    pinned?: boolean;
    branch?: string;
    sessionId?: string;
}

/**
 * The pack is capped so a large decision history cannot crowd out the diff.
 * 2000 tokens, lowest confidence dropped first.
 */
export const TRACE_CONTEXT_PACK_TOKEN_BUDGET = 2000;

/**
 * Rough token estimate. Deliberately cheap: the budget is a guardrail against
 * crowding out the diff, not an exact accounting, and a tokenizer round trip
 * per decision would cost more than it is worth here.
 */
export function estimateTokens(text: string): number {
    if (!text) {
        return 0;
    }
    return Math.ceil(text.length / 4);
}
