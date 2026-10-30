/**
 * code-review (domain) — reconstruct a throwable provider error from a
 * harness-swallowed error result.
 *
 * The agent harness is "observable by construction": a model/provider throw
 * inside the loop is caught and turned into an error-status result
 * (finishReason 'error') instead of a bare exception. So the base provider can't
 * rely on a thrown error to know the run failed — it inspects the result and, on
 * a swallowed provider error, rebuilds a throwable so the run fails LOUDLY
 * instead of returning a silent empty review.
 *
 * (The runtime provider FALLBACK this file used to also host was dropped in
 * 04b-05 — one model per task — so only the error-reconstruction helper remains.)
 */

/** Minimal shape of an agent-loop result this module reasons about. */
export interface ProviderRunResult {
    finishReason?: string;
    errorMessage?: string;
    errorName?: string;
    errorStatus?: number;
    errorResponseBody?: string;
}

/**
 * When an agent attempt ended in a harness-swallowed error result
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
