/**
 * The loop director (the harness policies) applied through the SDK's hooks
 * (A7), as the spike measured them (evals/results/claude-sdk-spike.md):
 *
 *   UserPromptSubmit  beforeStep(0): note → additionalContext, tools → kept
 *   PostToolBatch     the step is handed to the runner, then shouldStop(n) →
 *                     `continue: false`, else beforeStep(n): note →
 *                     additionalContext (a system message before the next
 *                     request), tools → kept
 *   PreToolUse        a tool outside the kept set → deny, with the note
 *   Stop              the run ends without the result tool → block once with
 *                     finalize(n)'s note, only its tools kept
 *
 * `unsupported` directives (message-window replacement, model switch) are
 * traced and skipped.
 */
import type { LoopDirector, LoopStepDirective } from '@libs/llm/agent-loop-call';

import { bareName } from './mcp-bridge';

export interface ToolBatchCall {
    tool_name: string;
    tool_input: unknown;
    tool_use_id: string;
    tool_response?: unknown;
}

export interface DirectorState {
    /** Steps handed to the runner so far. */
    steps: number;
    /** Bare tool names allowed now; undefined = all. */
    activeTools?: string[];
    /** The note of the current step, the reason given when a tool is denied. */
    note?: string;
    resultCalled: boolean;
    finalized: boolean;
    stopped: boolean;
}

export interface DirectorHookDeps {
    director?: LoopDirector;
    resultToolName?: string;
    state: DirectorState;
    /** Hands a finished tool step to the runner (its `onStepFinish`). */
    onToolBatch: (calls: ToolBatchCall[]) => Promise<void>;
    trace: (kind: string, detail: Record<string, unknown>) => void;
}

type HookFn = (input: any, toolUseId: string | undefined, opts: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

export function newDirectorState(): DirectorState {
    return { steps: 0, resultCalled: false, finalized: false, stopped: false };
}

function apply(state: DirectorState, d: LoopStepDirective, trace: DirectorHookDeps['trace'], step: number): string | undefined {
    state.activeTools = d.activeTools ? [...d.activeTools] : undefined;
    state.note = d.note;
    if (d.unsupported?.length) trace('policy.unsupported', { step, directives: d.unsupported });
    return d.note;
}

export function buildDirectorHooks(deps: DirectorHookDeps): Record<string, Array<{ hooks: HookFn[] }>> {
    const { director, resultToolName, state, trace } = deps;

    const userPromptSubmit: HookFn = async () => {
        if (!director) return {};
        const note = apply(state, await director.beforeStep(0), trace, 0);
        return note ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } } : {};
    };

    const postToolBatch: HookFn = async (input) => {
        const calls: ToolBatchCall[] = Array.isArray(input?.tool_calls) ? input.tool_calls : [];
        if (resultToolName && calls.some((c) => bareName(c.tool_name) === resultToolName)) state.resultCalled = true;
        await deps.onToolBatch(calls);
        if (!director) return {};
        if (await director.shouldStop(state.steps)) {
            state.stopped = true;
            return { continue: false, stopReason: 'policy stop' };
        }
        const note = apply(state, await director.beforeStep(state.steps), trace, state.steps);
        return note ? { hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: note } } : {};
    };

    const preToolUse: HookFn = async (input) => {
        const name = bareName(String(input?.tool_name ?? ''));
        if (state.activeTools && !state.activeTools.includes(name)) {
            trace('tool.denied', { tool: name, step: state.steps, allowed: state.activeTools });
            return {
                hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: `${name} is not available at this step.${state.note ? ` ${state.note}` : ''}`,
                },
            };
        }
        if (resultToolName && name === resultToolName) state.resultCalled = true;
        return {};
    };

    const stop: HookFn = async (input) => {
        if (!director || !resultToolName || state.resultCalled || state.finalized || input?.stop_hook_active) return {};
        const f = await director.finalize(state.steps);
        if (!f) return {};
        state.finalized = true;
        state.activeTools = f.activeTools ? [...f.activeTools] : undefined;
        state.note = f.note;
        trace('finalize.block', { step: state.steps });
        return { decision: 'block', reason: f.note };
    };

    return {
        UserPromptSubmit: [{ hooks: [userPromptSubmit] }],
        PostToolBatch: [{ hooks: [postToolBatch] }],
        PreToolUse: [{ hooks: [preToolUse] }],
        Stop: [{ hooks: [stop] }],
    };
}
