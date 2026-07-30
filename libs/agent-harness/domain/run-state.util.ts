/**
 * agent-harness — RunState helpers (domain, framework-agnostic).
 */
import type { RunState } from './contracts/run-state.contract';

/**
 * The free-form answer of a run: the last assistant turn carrying non-empty
 * text. This is the output mode for agents WITHOUT a `resultToolName` (chat,
 * single-shot analysis) — the structured "result tool" convention
 * (`RunState.artifacts`) is for agents that emit artifacts.
 *
 * Scans from the END because the final text step may follow tool-only steps
 * (the model called tools, then answered). Returns '' when no step produced text.
 */
export function finalText(state: RunState): string {
    for (let i = state.steps.length - 1; i >= 0; i--) {
        const content = state.steps[i]?.message?.content;
        if (typeof content === 'string' && content.trim().length > 0) {
            return content;
        }
    }
    return '';
}
