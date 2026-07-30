/**
 * Standard agent run context — the ONE way every agent builds its `ToolContext`.
 *
 * Gives a `runId` + an `AbortSignal` that fires on the parent signal OR after a
 * hard per-agent timeout, so a stuck run can't run forever and cancellation
 * propagates from the caller (router/workflow). Shared by code-review,
 * conversation and business so the robustness story is identical — no agent is
 * "less safe" than another by accident.
 *
 * Lives in @libs/llm (not the harness): it composes AGENT_TIMEOUT_MS +
 * composeAbortSignal, which are infra concerns. The harness stays signal-agnostic
 * (it just forwards `ctx.signal`).
 */
import { composeAbortSignal } from '@libs/common/utils/parent-signal-compose';
import { AGENT_TIMEOUT_MS } from '@libs/llm/llm-call';

export interface AgentRunContext {
    /** Pass straight to `runner.run(spec, input, ctx)`. */
    readonly ctx: { readonly runId: string; readonly signal: AbortSignal };
    /** Call in a `finally` — clears the timeout and detaches the parent listener. */
    readonly cleanup: () => void;
}

export function createAgentRunContext(params: {
    runId: string;
    /** Caller signal (workflow/router timeout) — cancellation propagates in. */
    parentSignal?: AbortSignal;
    /** Hard ceiling per agent. Defaults to AGENT_TIMEOUT_MS (30 min). */
    timeoutMs?: number;
}): AgentRunContext {
    const controller = new AbortController();
    const detach = composeAbortSignal(params.parentSignal, controller);
    const timeout = setTimeout(
        () => controller.abort(),
        params.timeoutMs ?? AGENT_TIMEOUT_MS,
    );
    return {
        ctx: { runId: params.runId, signal: controller.signal },
        cleanup: () => {
            clearTimeout(timeout);
            detach();
        },
    };
}
