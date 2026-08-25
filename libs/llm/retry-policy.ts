/**
 * App-level retry policy for ONE-SHOT LLM calls (the structured-review path) —
 * the single source of truth for "which failures are worth one more try, and how
 * long to wait first".
 *
 * Scope boundary (why this is NOT the harness's retry): there are two DIFFERENT
 * retry layers, not one drifting concern —
 *   - the agentic loop retries a STEP via the AI SDK's own `maxRetries` (a
 *     harness concern, model-agnostic, no error taxonomy — it stays free of
 *     `@libs/llm`);
 *   - a one-shot call owns a SINGLE app-level re-issue here, because it needs the
 *     `LlmErrorCategory` taxonomy + the BYOK limiter's cooldown awareness (D-00c).
 * This module owns only the second. Keeping the classification + the backoff
 * curve here means a new one-shot caller inherits the same policy for free.
 *
 * Backoff adds JITTER (the opencode lesson): the old re-issue fired IMMEDIATELY,
 * so N parallel review shards hitting the same transient-failing provider all
 * re-fired in lockstep — a thundering herd. Full-jitter backoff spreads them.
 */
import { classifyLLMError, LlmErrorCategory } from './error-classifier';

/**
 * The ONE category an app-level re-issue fires on. A RATE_LIMIT (429) is
 * DELIBERATELY excluded — it backs off through the slot's limiter cooldown
 * instead of an instant same-model re-fire; AUTH/QUOTA/CONTEXT_OVERFLOW are
 * terminal (no re-issue helps).
 */
export const RETRYABLE_CATEGORY = LlmErrorCategory.TRANSIENT;

/** True when a one-shot call should re-issue once for this error. */
export function isRetryableForReissue(err: unknown, provider?: string): boolean {
    return classifyLLMError(err, provider).category === RETRYABLE_CATEGORY;
}

export const RETRY_BASE_DELAY_MS = 500;
export const RETRY_MAX_DELAY_MS = 10_000;

/**
 * Exponential backoff with FULL jitter, capped. `attempt` is 1-based. The delay
 * is a uniform random in `[0.5, 1] × min(cap, base·2^(attempt-1))` — enough
 * spread to break lockstep re-fires without adding meaningful latency to a single
 * call. `Math.random` is fine here (app code, not a workflow script).
 */
export function jitteredBackoffMs(
    attempt: number,
    base: number = RETRY_BASE_DELAY_MS,
    cap: number = RETRY_MAX_DELAY_MS,
): number {
    const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
    return Math.round(exp * (0.5 + Math.random() * 0.5));
}

export const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
