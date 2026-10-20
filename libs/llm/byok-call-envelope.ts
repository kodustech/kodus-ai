/**
 * What every BYOK model request goes through, whatever runtime sends it.
 *
 * The AI SDK path reaches it from `wrapByokModel` (one envelope per
 * `doGenerate`); a runtime that makes its own HTTP calls (the Claude Agent
 * SDK's CLI, behind the EE gateway) reaches it per upstream request. Both get
 * the same limiter admission, the same tpm estimate and reconcile, and on
 * failure the same classification, cooldown and reporter payload — so a slot
 * behaves the same whichever runtime served the call.
 *
 * Runtime-specific work stays with each caller: the AI SDK wrapper retries a
 * refused reasoning field by editing `params`; a gateway forwards bytes.
 */
import type { NormalizedModel } from '@libs/llm/byok-config';
import { runWithBYOKLimiter, getLimiterForSlot } from '@libs/llm/byok-to-vercel';
import { estimateTextTokens } from '@libs/llm/token-estimate';
import {
    attachClassification,
    classifyLLMError,
    LlmErrorCategory,
    type ClassifiedErrorInfo,
} from '@libs/llm/error-classifier';
import { extractProviderMessage } from '@libs/llm/review-error-diagnostics';

/** The BYOK failure reporter (drives the `byok.llm_errors_threshold` notification). */
export type ByokFailureReporter = (input: {
    organizationId?: string;
    provider: string;
    /** The provider's own sentence when it gave one, else `err.message`. */
    errorMessage: string;
    category?: LlmErrorCategory;
    httpStatus?: number;
    routingRefusal?: boolean;
}) => void;

export interface ByokEnvelopeOptions {
    slot?: NormalizedModel;
    organizationId?: string;
    /** Provider named in the classification and the report (defaults to the slot's). */
    provider?: string;
    queueTimeoutMs?: number;
    reporter?: ByokFailureReporter;
}

export interface ByokEnvelopeRequest<T> {
    abortSignal?: AbortSignal;
    /** The prompt as the provider sees it; only read when the slot has a tpm budget. */
    prompt?: unknown;
    /** Real token total from the result, for the tpm reconcile. */
    usageTokens?: (result: T) => number | undefined;
}

/**
 * PRE-call token estimate for the tpm reservoir. Serializes the wire prompt the
 * same way the provider sees it, then counts with the SHARED tiktoken estimator
 * (`estimateTextTokens`) — NOT a char/4 heuristic (flat-4 under-counts dense
 * code ~1.6×).
 */
export function estimatePromptTokens(prompt: unknown): number {
    if (prompt == null) return 0;
    const text = typeof prompt === 'string' ? prompt : safeSerialize(prompt);
    return estimateTextTokens(text);
}

function safeSerialize(value: unknown): string {
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        return String(value);
    }
}

/**
 * Classify a failed request, attach the category to the error, arm the slot's
 * cooldown on a rate limit, and report it. Never throws: a reporter failure must
 * not mask the LLM error. Returns the classification.
 */
export function reportByokFailure(
    opts: ByokEnvelopeOptions,
    err: unknown,
): ClassifiedErrorInfo | undefined {
    let classified: ClassifiedErrorInfo | undefined;
    if (err && typeof err === 'object') {
        classified = classifyLLMError(err, opts.provider);
        attachClassification(err, classified);

        // Arm the slot's cooldown ONLY on a classified RATE_LIMIT (429-rate)
        // when the slot opted in via cooldownMs. A QUOTA_EXCEEDED (429-billing)
        // and a TRANSIENT (5xx/network) NEVER arm. Arming is a DELAY, not a
        // retry: the limiter holds the next admission.
        const cooldownMs = opts.slot?.cooldownMs;
        if (
            classified.category === LlmErrorCategory.RATE_LIMIT &&
            !!cooldownMs &&
            cooldownMs > 0
        ) {
            getLimiterForSlot({
                slot: opts.slot,
                organizationId: opts.organizationId,
            })?.armCooldown(cooldownMs);
        }
    }
    try {
        opts.reporter?.({
            organizationId: opts.organizationId,
            provider: opts.provider ?? opts.slot?.provider ?? 'unknown',
            // For an AI SDK `APICallError` the message only restates the status
            // ("Provider returned error"); the cause is in the body (#1871).
            errorMessage:
                extractProviderMessage(err) ??
                (err instanceof Error ? err.message : String(err ?? 'unknown')),
            category: classified?.category,
            httpStatus: classified?.httpStatus,
            routingRefusal: classified?.routingRefusal,
        });
    } catch {
        /* reporter failures must not surface */
    }
    return classified;
}

/**
 * Run one model request inside the slot's BYOK envelope: limiter admission
 * (with the tpm estimate and reconcile when the slot has a tpm budget), and on
 * a thrown error, `reportByokFailure` before it propagates.
 */
export function runInByokEnvelope<T>(
    opts: ByokEnvelopeOptions,
    request: ByokEnvelopeRequest<T>,
    send: () => Promise<T>,
): Promise<T> {
    const run = async () => {
        try {
            return await send();
        } catch (err) {
            reportByokFailure(opts, err);
            throw err;
        }
    };

    // tpm reservoir (hybrid): debit the estimate at admission and reconcile
    // against the real usage after the call. Only when the slot carries tpm —
    // otherwise zero estimation overhead (rpm/concurrency only).
    const hasTpm = !!opts.slot?.tpm && opts.slot.tpm > 0;
    return runWithBYOKLimiter<T>(
        {
            slot: opts.slot,
            organizationId: opts.organizationId,
            abortSignal: request.abortSignal,
            queueTimeoutMs: opts.queueTimeoutMs,
            estimatedTokens: hasTpm ? estimatePromptTokens(request.prompt) : undefined,
            getUsageTokens: hasTpm ? request.usageTokens : undefined,
        },
        run,
        'llm-call',
    );
}
