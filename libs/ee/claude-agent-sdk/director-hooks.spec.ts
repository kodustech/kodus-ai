import type { LoopDirector } from '@libs/llm/agent-loop-call';

import { buildDirectorHooks, newDirectorState } from './director-hooks';

const signal = new AbortController().signal;
const hook = (hooks: any, event: string) => (input: any) => hooks[event][0].hooks[0](input, undefined, { signal });

function setup(director: Partial<LoopDirector>, resultToolName: string | undefined = 'submitResult') {
    const state = newDirectorState();
    const batches: any[] = [];
    const trace: any[] = [];
    const full: LoopDirector = {
        beforeStep: async () => ({}),
        shouldStop: async () => false,
        finalize: async () => null,
        ...director,
    };
    const hooks = buildDirectorHooks({
        director: full,
        resultToolName,
        state,
        onToolBatch: async (calls) => {
            batches.push(calls);
            state.steps += 1;
        },
        trace: (kind, detail) => trace.push({ kind, detail }),
    });
    return { state, batches, trace, hooks };
}

describe('director hooks', () => {
    it('UserPromptSubmit: step 0 note as additionalContext, its tools kept', async () => {
        const { hooks, state } = setup({ beforeStep: async (n) => (n === 0 ? { note: 'start here', activeTools: ['readFile'] } : {}) });
        expect(await hook(hooks, 'UserPromptSubmit')({})).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'start here' } });
        expect(state.activeTools).toEqual(['readFile']);
    });

    it('PostToolBatch: hands the step over first, then asks for the next step’s note', async () => {
        const seen: number[] = [];
        const { hooks, batches } = setup({
            beforeStep: async (n) => {
                seen.push(n);
                return { note: `note ${n}` };
            },
        });
        const calls = [{ tool_name: 'mcp__kodus__readFile', tool_input: { path: 'a' }, tool_use_id: 't1', tool_response: 'x' }];
        expect(await hook(hooks, 'PostToolBatch')({ tool_calls: calls })).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: 'note 1' } });
        expect(batches).toEqual([calls]);
        expect(seen).toEqual([1]);
    });

    it('PostToolBatch: a policy stop ends the run with continue:false', async () => {
        const { hooks, state } = setup({ shouldStop: async (n) => n >= 1 });
        expect(await hook(hooks, 'PostToolBatch')({ tool_calls: [] })).toEqual({ continue: false, stopReason: 'policy stop' });
        expect(state.stopped).toBe(true);
    });

    it('PreToolUse: denies a tool outside the kept set with the step note, allows the rest', async () => {
        const { hooks, state, trace } = setup({});
        state.activeTools = ['submitResult'];
        state.note = 'Submit now.';
        expect(await hook(hooks, 'PreToolUse')({ tool_name: 'mcp__kodus__grep' })).toEqual({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'grep is not available at this step. Submit now.' },
        });
        expect(trace[0]).toMatchObject({ kind: 'tool.denied', detail: { tool: 'grep' } });
        expect(await hook(hooks, 'PreToolUse')({ tool_name: 'mcp__kodus__submitResult' })).toEqual({});
        expect(state.resultCalled).toBe(true);
    });

    it('Stop: blocks once with the finalize note when the result tool was not called', async () => {
        const { hooks, state } = setup({ finalize: async () => ({ note: 'Call submitResult now.', activeTools: ['submitResult'] }) });
        expect(await hook(hooks, 'Stop')({ stop_hook_active: false })).toEqual({ decision: 'block', reason: 'Call submitResult now.' });
        expect(state.activeTools).toEqual(['submitResult']);
        expect(await hook(hooks, 'Stop')({ stop_hook_active: false })).toEqual({});
        expect(await hook(hooks, 'Stop')({ stop_hook_active: true })).toEqual({});
    });

    it('Stop: lets the run end when the result tool was called or no policy finalizes', async () => {
        const called = setup({ finalize: async () => ({ note: 'x' }) });
        called.state.resultCalled = true;
        expect(await hook(called.hooks, 'Stop')({})).toEqual({});
        expect(await hook(setup({}).hooks, 'Stop')({})).toEqual({});
        // A loop without a result tool (a text-answer agent) is never blocked.
        expect(await hook(setup({ finalize: async () => ({ note: 'x' }) }, '').hooks, 'Stop')({})).toEqual({});
    });

    it('traces a directive the SDK cannot apply and goes on', async () => {
        const { hooks, trace } = setup({ beforeStep: async () => ({ unsupported: ['messages'] }) });
        expect(await hook(hooks, 'PostToolBatch')({ tool_calls: [] })).toEqual({});
        expect(trace).toEqual([{ kind: 'policy.unsupported', detail: { step: 1, directives: ['messages'] } }]);
    });
});
