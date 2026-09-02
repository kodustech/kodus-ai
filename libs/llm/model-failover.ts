/**
 * Runtime model FAILOVER — cascade `primary → fallback` when a call fails.
 *
 * The routing layer (`resolveTaskSlot`) already decides WHICH model runs a task
 * and stamps the org's configured fallback onto `slot.fallback`. This owns the
 * OTHER half: when the model that ran actually FAILS at call time in a way a
 * different model can fix, re-run the call once on the fallback. It is the
 * OUTERMOST retry — it wraps the executor, which already owns the same-model
 * recovery (SDK per-step retry, the one-shot D-00c re-issue, the limiter's
 * cooldown). So a model is only abandoned after it has exhausted its OWN retries.
 *
 * This is NOT a runtime failover cascade of N models: at most one hop
 * (primary → fallback), matching the single `routing.fallbackModelId` the user
 * configures. `fallback` is a deliberate backup (often a cheaper/steadier model),
 * not "the next tier" — the selection precedence (per-agent → default) is a
 * SEPARATE concern owned by the router, not re-walked here.
 */
import { createLogger } from '@libs/core/log/logger';
import { LLM_ERROR_TAG, LLM_SUCCESS_TAG } from '@libs/llm/log-tags';
import type { NormalizedModel } from '@libs/llm/byok-config';
import {
    classifyLLMError,
    isAbortOrHardTimeout,
    isTerminalCategory,
    LlmErrorCategory,
} from '@libs/llm/error-classifier';

const logger = createLogger('ModelFailover');

/**
 * Should a failed call cascade to the FALLBACK model? True only when a DIFFERENT
 * model can plausibly fix it — the whole point of a per-org fallback:
 *  - TERMINAL model-specific failures (bad/expired key, out of credit, unknown
 *    model, access denied): the primary provably can't serve this org/task.
 *  - A TRANSIENT (5xx / network) blip that OUTLIVED the executor's same-model
 *    retries — persistent enough that the provider itself looks down.
 *
 * Deliberately NOT cascaded (a peer model doesn't help, or another layer owns it):
 *  - RATE_LIMIT — the per-slot limiter owns backoff/cooldown; swapping models on a
 *    429 would just defeat the rate gate and hammer providers.
 *  - CONTEXT_OVERFLOW — the prompt is too big; a same-class fallback won't fit it.
 *  - Abort / hard-timeout — the failure is latency or a cancel, not the model;
 *    re-running burns the whole timeout budget again.
 *  - UNKNOWN — unclassified; stay conservative rather than spend a 2nd billed call.
 */
export function shouldFailoverToNextModel(err: unknown): boolean {
    if (isAbortOrHardTimeout(err)) {
        return false;
    }
    const { category } = classifyLLMError(err);
    switch (category) {
        case LlmErrorCategory.RATE_LIMIT:
        case LlmErrorCategory.CONTEXT_OVERFLOW:
        case LlmErrorCategory.UNKNOWN:
            return false;
        case LlmErrorCategory.TRANSIENT:
            return true;
        default:
            return isTerminalCategory(category);
    }
}

/** Handed to each attempt so it can veto its own retry. */
export interface FailoverAttemptControl {
    /**
     * Mark THIS attempt as no longer safely restartable — it has emitted output a
     * fresh run would DUPLICATE (an agent-loop step already ran + mutated shared
     * runner state). After this is called, a cascade-worthy error still propagates
     * instead of retrying on the fallback. One-shot calls are atomic (nothing is
     * committed until they return) and never call this, so they always fail over.
     */
    markUnsafeToRetry(): void;
}

/** Distinct, order-preserving attempts. Drops a fallback that resolves to the same
 *  model as the primary; the managed-default attempt (`undefined`) is only ever the
 *  sole entry — never queued as a fallback after a real slot. */
function distinctAttempts(
    slots: Array<NormalizedModel | undefined>,
): Array<NormalizedModel | undefined> {
    const out: Array<NormalizedModel | undefined> = [];
    const seen = new Set<string>();
    for (const slot of slots) {
        if (!slot) {
            if (out.length === 0) {
                out.push(slot);
            }
            continue;
        }
        const key = slot.byokModelId ?? slot.model;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(slot);
    }
    return out.length > 0 ? out : [undefined];
}

/**
 * Run `runOne` on the primary slot; on a cascade-worthy failure it could not
 * recover from, re-run once on the fallback (the tail of `slots`). Returns the
 * first success; re-throws the LAST error when every attempt is exhausted or the
 * failure is not cascade-worthy. With a single slot (no fallback) this is a thin
 * pass-through — `runOne` is invoked exactly once.
 */
export async function runWithModelFailover<T>(
    slots: Array<NormalizedModel | undefined>,
    runOne: (
        slot: NormalizedModel | undefined,
        control: FailoverAttemptControl,
    ) => Promise<T>,
    opts: { runName: string; organizationId?: string },
): Promise<T> {
    const attempts = distinctAttempts(slots);

    for (let i = 0; i < attempts.length; i++) {
        let unsafeToRetry = false;
        const control: FailoverAttemptControl = {
            markUnsafeToRetry: () => {
                unsafeToRetry = true;
            },
        };

        try {
            const result = await runOne(attempts[i], control);
            // DEBUG level: completes the [LLM-ERROR]/[LLM-SUCCESS] pair at the one
            // chokepoint every LLM.run funnels through, WITHOUT flooding prod —
            // one success line per call is too much at info, so it stays off
            // unless debug logging is enabled (then a full call trace is greppable
            // by tag). `usedFallback` flags a call that only survived via failover.
            logger.debug({
                message: `${LLM_SUCCESS_TAG} ${opts.runName}: "${attempts[i]?.model ?? 'managed-default'}" ok${i > 0 ? ' (via fallback)' : ''}`,
                context: 'runWithModelFailover',
                metadata: {
                    runName: opts.runName,
                    organizationId: opts.organizationId,
                    modelId: attempts[i]?.byokModelId,
                    usedFallback: i > 0,
                },
            });
            return result;
        } catch (err) {
            const isLast = i >= attempts.length - 1;
            if (isLast || unsafeToRetry || !shouldFailoverToNextModel(err)) {
                // Terminal failure: no more attempts (or this error must not
                // cascade). Emit ONE greppable [LLM-ERROR] line here — the single
                // chokepoint every LLM.run call funnels through — so a failed LLM
                // call is findable in the logs with model + classified cause,
                // instead of dying as an unlogged re-throw. WARN level: a terminal
                // LLM failure is a user config/billing/provider problem, not an
                // app outage (mirrors the failover swap below).
                const { category } = classifyLLMError(err);
                logger.warn({
                    message: `${LLM_ERROR_TAG} ${opts.runName}: "${attempts[i]?.model ?? 'managed-default'}" failed (${category}) — ${(err as Error)?.message ?? 'unknown error'}`,
                    context: 'runWithModelFailover',
                    metadata: {
                        runName: opts.runName,
                        organizationId: opts.organizationId,
                        category,
                        modelId: attempts[i]?.byokModelId,
                        exhausted: isLast,
                    },
                });
                throw err;
            }

            const { category } = classifyLLMError(err);
            const from = attempts[i]?.model ?? 'managed-default';
            const to = attempts[i + 1]?.model ?? 'managed-default';
            // WARN not ERROR: a terminal failure is a user config/billing problem
            // (mirrors llmErrorLogLevel), and the run still succeeds via the
            // fallback — the interesting signal is the SWAP, not an outage.
            logger.warn({
                message: `${LLM_ERROR_TAG} [model-failover] ${opts.runName}: "${from}" failed (${category}); cascading to fallback "${to}"`,
                context: 'runWithModelFailover',
                metadata: {
                    runName: opts.runName,
                    organizationId: opts.organizationId,
                    category,
                    fromModelId: attempts[i]?.byokModelId,
                    toModelId: attempts[i + 1]?.byokModelId,
                },
            });
        }
    }

    // Unreachable: `distinctAttempts` guarantees ≥1 attempt, and the LAST one always
    // throws in the catch above (`isLast`). This satisfies the compiler's need for a
    // terminal path without carrying a dead "last error" across iterations.
    throw new Error(
        `runWithModelFailover(${opts.runName}): exhausted attempts without returning`,
    );
}
