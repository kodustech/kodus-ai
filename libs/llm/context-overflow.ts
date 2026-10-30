/**
 * Reactive context-overflow detection for a finished agent run.
 *
 * The proactive `ContextWindowCompressor` trims the window BEFORE it overflows,
 * but it works off an estimate that can be wrong (issue #1574 — a mis-sized
 * window let the loop overflow mid-run). When that happens the harness returns a
 * `RunState{status:'error'}` instead of a usable result. This is the seam a
 * caller uses to notice "that failure was an overflow" and re-run ONCE with a
 * tighter compression budget — recovering instead of failing the whole run.
 *
 * Lives in `@libs/llm` (it needs the `LlmErrorCategory` taxonomy); the harness
 * stays free of it — the recovery is a CALLER concern, not a core-loop one.
 * `RunState` is imported type-only, so there is no runtime dependency on the
 * harness.
 */
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import { classifyLLMError, LlmErrorCategory } from './error-classifier';

/**
 * The error text a failed run recorded in its trace. The runner emits
 * `{ kind: 'error', detail: { message, responseBody? } }` on a model/provider
 * throw; both are folded in so the classifier sees the actionable detail (the AI
 * SDK often puts a terse phrase in `message` and the real reason in the body).
 * Empty string for a clean run (nothing to classify).
 */
export function runStateErrorText(state: RunState): string {
    if (state.status !== 'error') return '';
    for (const event of state.trace ?? []) {
        const e = event as { kind?: string; detail?: Record<string, unknown> };
        if (e.kind === 'error') {
            const detail = e.detail ?? {};
            return `${detail.message ?? ''} ${detail.responseBody ?? ''}`.trim();
        }
    }
    return '';
}

/**
 * True when a failed run failed BECAUSE the prompt overflowed the model's context
 * window — the recoverable case where re-running with tighter compression helps.
 * A run that failed for any other reason (auth, rate-limit, transient) returns
 * false, so the caller doesn't waste a re-run on an unrecoverable error.
 */
export function isContextOverflowResult(state: RunState): boolean {
    const text = runStateErrorText(state);
    if (!text) return false;
    return (
        classifyLLMError(new Error(text)).category ===
        LlmErrorCategory.CONTEXT_OVERFLOW
    );
}
