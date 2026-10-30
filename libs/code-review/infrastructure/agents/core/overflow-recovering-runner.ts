/**
 * A runner decorator that recovers from a mid-loop context overflow.
 *
 * The proactive `ContextWindowCompressor` sizes the message window from an
 * ESTIMATE that can be wrong (issue #1574) — a mis-sized window lets the loop
 * overflow mid-run, and the harness returns a `RunState{status:'error'}` instead
 * of findings, failing the whole pass. This wrapper turns that hard failure into
 * a degraded-but-useful result: on an overflow error it re-runs the pass ONCE
 * with a tighter compression window (the compressor trims harder), exactly like
 * the skill fetcher's inline net — but applied to EVERY sub-run of the finder
 * (base + heavy resamples + synthesis-rescue) by wrapping the shared runner, so
 * the multi-pass finder gets the net in one place without threading it per call.
 *
 * Lives in the code-review layer, not the harness: the recovery is a CALLER
 * concern (same boundary as `@libs/llm/context-overflow`). Non-overflow failures
 * (auth, rate-limit, transient) pass through untouched — re-running wouldn't help.
 */
import type {
    AgentRunInput,
    AgentRunner,
    AgentSpec,
} from '@libs/agent-harness/domain/contracts/agent.contract';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import type { ToolContext } from '@libs/agent-harness/domain/contracts/tool.contract';
import { isContextOverflowResult } from '@libs/llm/context-overflow';

/** Rebuild `spec` with its compression window scaled by `scale` (< 1 tightens).
 *  Returns a spec whose loop compacts more aggressively; callers that don't know
 *  the window (no compression configured) return the spec unchanged. */
export type SpecTightener = (spec: AgentSpec, scale: number) => AgentSpec;

export class OverflowRecoveringRunner implements AgentRunner {
    constructor(
        private readonly inner: AgentRunner,
        private readonly tighten: SpecTightener,
        /** Fraction of the original window to retry at — 60% mirrors the fetcher. */
        private readonly retryScale = 0.6,
    ) {}

    async run(
        spec: AgentSpec,
        input: AgentRunInput,
        ctx: ToolContext,
    ): Promise<RunState> {
        const state = await this.inner.run(spec, input, ctx);
        if (!isContextOverflowResult(state)) return state;
        // Single retry at a tighter window — never recurses (the retry's result
        // is returned as-is even if it overflows again).
        return this.inner.run(
            this.tighten(spec, this.retryScale),
            input,
            ctx,
        );
    }
}
