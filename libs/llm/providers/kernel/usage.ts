/**
 * Shared usage normalization for provider modules (Phase 3, D-01 / Q4).
 *
 * The AI SDK collapses EVERY provider's raw response into the same high-level
 * `LanguageModelUsage` shape (`usage.inputTokens` / `usage.outputTokens` /
 * `usage.outputTokenDetails.reasoningTokens`) before a module ever sees it, so
 * usage extraction is byte-identical across all nine modules. This is that one
 * implementation — each module's `normalizeUsage` / `normalize` points here
 * instead of carrying its own copy (was duplicated verbatim 9×).
 *
 * Reads the same fields observability.service.ts reads off the generateText
 * result, so cost projection stays a single source of truth. ai@7 nests
 * reasoning under `outputTokenDetails.reasoningTokens`; the top-level
 * `reasoningTokens` is the ai@6 flat fallback. Reasoning is a detail-OF output —
 * `output` is the FULL completion count and is NEVER reduced by reasoning (Q4
 * double-count trap: `total` = input + output; reasoning is additive info only).
 */
import type { ModelResult, NormalizedUsage } from './types';

export function normalizeSdkUsage(raw: unknown): NormalizedUsage {
    const u = (raw as { usage?: Record<string, any> } | undefined)?.usage ?? {};
    return {
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        reasoning:
            u.outputTokenDetails?.reasoningTokens ?? u.reasoningTokens ?? 0,
    };
}

export function normalizeSdkResult(raw: unknown): ModelResult {
    return { usage: normalizeSdkUsage(raw), raw };
}
