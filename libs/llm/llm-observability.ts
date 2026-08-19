/**
 * Narrow observability PORT for the LLM primitive (dependency inversion).
 *
 * `LLM.run` (and the executor it wraps) must record a billing/telemetry span
 * around every model call. But it lives in @libs/llm and runs from BOTH DI
 * (NestJS services) and non-DI (pure functions, CLI, evals) call sites, so it
 * cannot inject a service. Instead it depends on THIS narrow port: the app
 * registers its implementation once at bootstrap via `setLlmObservability`, and
 * the primitive reads it via `getLlmObservability`. Absent (a bare unit test
 * that never registered one) → the call runs without a span.
 *
 * This inverts the dependency: @libs/llm declares what it needs; @libs/core
 * implements it — no reaching into a concrete service singleton from the lib.
 */
export interface LlmObservability {
    /** Wrap an AI SDK call in a billing span; reads usage from the result. */
    runAiSdkLLMInSpan<
        T extends {
            usage?: {
                inputTokens?: number;
                outputTokens?: number;
                totalTokens?: number;
                reasoningTokens?: number;
            };
        },
    >(params: {
        spanName: string;
        runName?: string;
        model?: string;
        /** BYOK v2 model id (stable id) — per-model billing attribution. */
        byokModelId?: string;
        /** Credential the resolved model used — per-key spend attribution. */
        credentialId?: string;
        /** Routing task/route this call served. */
        route?: string;
        /** True when a fallback model served instead of the primary. */
        usedFallback?: boolean;
        attrs?: Record<string, any>;
        exec: () => Promise<T>;
    }): Promise<T>;
}

let current: LlmObservability | undefined;

/** Register the app's observability implementation (once, at bootstrap). */
export function setLlmObservability(impl: LlmObservability | undefined): void {
    current = impl;
}

/** The registered observability, or undefined (→ the call runs without a span). */
export function getLlmObservability(): LlmObservability | undefined {
    return current;
}
