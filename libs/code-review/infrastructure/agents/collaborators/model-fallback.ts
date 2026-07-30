/**
 * code-review (domain) — provider fallback for the v5 agent loop.
 *
 * The agent harness resolves ONE model and runs; unlike the v2 legacy flow
 * (LangChain `.withFallbacks`), it has no built-in retry against a second
 * provider. This wrapper gives the agent providers the same resilience the org
 * already expects from its BYOK `fallback` config: run the `main` model, and if
 * it fails, retry ONCE against `fallback`.
 *
 * "Fails" means EITHER:
 *   - a thrown provider/API error (e.g. preflight, or an error that escapes the
 *     harness), OR
 *   - a non-throwing FAILURE RESULT. The agent harness is "observable by
 *     construction": a model/provider throw inside the loop is caught and
 *     turned into an error-status result (finishReason 'error') instead of a
 *     bare exception. Verified end-to-end — a bogus main model produced
 *     "0 suggestions, 0 failures" and never threw. So a throw-only check would
 *     silently miss the main failure and never reach the fallback. `isFailure`
 *     detects that swallowed error so the fallback still fires.
 *
 * Budget exhaustion returns finishReason 'timeout' (not 'error'), so callers'
 * `isFailure` must NOT treat it as a failure — retrying a full loop after a
 * 30-min timeout would just double the latency.
 */
import type { AgentModelParams } from '@libs/code-review/infrastructure/agents/collaborators/model-factory';

export interface ProviderFallbackOptions<T> {
    /** Runs the model call for one role. Called at most twice (main, fallback). */
    attempt: (params: AgentModelParams) => Promise<T>;
    main: AgentModelParams;
    /** Null when the org configured no fallback provider. */
    fallback: AgentModelParams | null;
    /**
     * Decide whether a `main` failure should trigger the fallback. Defaults to
     * "always". Callers pass this to suppress fallback on genuine job
     * cancellation (retrying a cancelled review just wastes work). Receives the
     * thrown error, or the failed result when `isFailure` tripped.
     */
    shouldFallback?: (reason: unknown) => boolean;
    /**
     * Detects a non-throwing failure result (the harness swallows model errors
     * into an error-status result). Returning true for the main result triggers
     * the fallback exactly as a thrown error would.
     */
    isFailure?: (result: T) => boolean;
    /** Side-effect hook (logging/telemetry) fired just before the retry.
     *  Receives the thrown error or the failed result. */
    onFallback?: (reason: unknown) => void | Promise<void>;
}

/**
 * Run `attempt(main)`; if it throws OR returns a failure result, optionally run
 * `attempt(fallback)` once. When there is no fallback (or `shouldFallback`
 * vetoes), the original error/result is preserved — behavior identical to the
 * pre-fallback code.
 */
export async function runWithProviderFallback<T>(
    opts: ProviderFallbackOptions<T>,
): Promise<T> {
    const fallbackAllowed = (reason: unknown) =>
        !!opts.fallback && (opts.shouldFallback?.(reason) ?? true);

    // Isolate the caller's hook: a failing logging/telemetry callback must
    // never prevent the fallback retry from running (that would mask the very
    // provider error we're recovering from).
    const notifyFallback = (reason: unknown) => {
        try {
            const maybePromise = opts.onFallback?.(reason);
            if (maybePromise) {
                maybePromise.catch(() => {});
            }
        } catch {
            /* hook failures are non-fatal to the retry */
        }
    };

    let mainResult: T;
    try {
        mainResult = await opts.attempt(opts.main);
    } catch (error) {
        if (!fallbackAllowed(error)) {
            throw error;
        }
        notifyFallback(error);
        return opts.attempt(opts.fallback!);
    }

    // Non-throwing failure (harness-swallowed provider error): fall back too.
    if (opts.isFailure?.(mainResult) && fallbackAllowed(mainResult)) {
        notifyFallback(mainResult);
        return opts.attempt(opts.fallback!);
    }

    return mainResult;
}

/** Minimal shape of an agent-loop result this module reasons about. */
export interface ProviderRunResult {
    finishReason?: string;
    errorMessage?: string;
    errorName?: string;
    errorStatus?: number;
    errorResponseBody?: string;
}

/**
 * When every provider attempt ended in a harness-swallowed error result
 * (finishReason 'error'), reconstruct a throwable error so the caller can fail
 * the agent LOUDLY instead of returning a silent empty review. Returns null for
 * a healthy result (including a legit empty or a 'timeout'/budget stop).
 *
 * The reconstructed error carries the original provider message so downstream
 * `classifyLLMError` can categorise it (model-not-found, quota, auth, …) for the
 * end-review comment.
 */
export function providerErrorFromResult(
    result: ProviderRunResult | undefined,
): Error | null {
    if (result?.finishReason !== 'error') {
        return null;
    }
    const error = new Error(
        result.errorMessage ??
            'agent run failed: BYOK provider call returned an error',
    );
    if (result.errorName) {
        error.name = result.errorName;
    }
    // Re-attach the upstream status/body under the property names
    // `classifyLLMError` reads. Without them a 404 reconstructed here looks
    // like a bare Error("Not Found"), which matches no rule and degrades to
    // UNKNOWN — the user then sees "Unexpected error while running the code
    // review" instead of "verify the model name in your settings" (#1568).
    if (result.errorStatus !== undefined) {
        (error as Error & { statusCode?: number }).statusCode =
            result.errorStatus;
    }
    if (result.errorResponseBody) {
        (error as Error & { responseBody?: string }).responseBody =
            result.errorResponseBody;
    }
    return error;
}
