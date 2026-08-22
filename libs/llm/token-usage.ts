/**
 * `TokenUsage` — the token-accounting shape reported by an LLM call (input /
 * output / cache token counts) and consumed by cost attribution.
 */
export type TokenUsage = {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    /** quando disponível (ex.: modelos de reasoning) */
    output_reasoning_tokens?: number;

    /** metadados úteis p/ observabilidade */
    model?: string;
    runId?: string;
    parentRunId?: string;
    runName?: string;
};
