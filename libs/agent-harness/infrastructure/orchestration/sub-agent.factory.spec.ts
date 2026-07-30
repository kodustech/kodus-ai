/**
 * DefaultSubAgentFactory unit tests — deterministic, zero LLM.
 *
 * Proves the sub-agent-as-tool keystone with a MOCK AgentRunner: calling the
 * resulting tool runs the spec, maps input->prompt, and returns
 * summarize(state). This is the foundation that lets verify and replicas be
 * pure composition (no second loop).
 */
import type {
    AgentRunner,
    AgentSpec,
} from '../../domain/contracts/agent.contract';
import type { RunState } from '../../domain/contracts/run-state.contract';
import type {
    ToolContext,
    ToolRegistry,
} from '../../domain/contracts/tool.contract';
import { DefaultSubAgentFactory } from './sub-agent.factory';

const emptyRegistry: ToolRegistry = {
    get: () => undefined,
    list: () => [],
};

const spec: AgentSpec = {
    id: 'verifier',
    systemPrompt: 'verify the claim',
    modelId: 'gemini',
    tools: emptyRegistry,
    policies: [],
    maxSteps: 4,
};

function mockRunner(state: RunState): AgentRunner & { calls: any[] } {
    const calls: any[] = [];
    return {
        calls,
        run: async (s, input, ctx) => {
            calls.push({ specId: s.id, prompt: input.prompt, runId: ctx.runId });
            return state;
        },
    };
}

const ctx: ToolContext = { runId: 'run-1' };

const cannedState: RunState = {
    runId: 'run-1',
    agentId: 'verifier',
    status: 'completed',
    steps: [{ index: 0, message: { role: 'assistant', content: 'kept' } }],
    artifacts: [],
    usage: {},
    trace: [],
};

describe('DefaultSubAgentFactory', () => {
    it('exposes a spec as a tool with a default {task} schema', () => {
        const f = new DefaultSubAgentFactory(mockRunner(cannedState));
        const t = f.asTool({
            name: 'verify',
            description: 'verify a finding',
            spec,
            toPrompt: (i: any) => i.task,
            summarize: (s) => s.steps[0].message.content,
        });
        expect(t.name).toBe('verify');
        expect(t.inputSchema.required).toContain('task');
    });

    it('runs the sub-agent spec and returns the distilled summary', async () => {
        const runner = mockRunner(cannedState);
        const f = new DefaultSubAgentFactory(runner);
        const t = f.asTool({
            name: 'verify',
            description: 'verify a finding',
            spec,
            toPrompt: (i: any) => `verify: ${i.task}`,
            summarize: (s) => s.steps[s.steps.length - 1].message.content,
        });

        const r = await t.execute({ task: 'null deref at L10' }, ctx);

        // ran the right spec with the mapped prompt + propagated context
        expect(runner.calls[0]).toEqual({
            specId: 'verifier',
            prompt: 'verify: null deref at L10',
            runId: 'run-1',
        });
        // returned the distilled summary, not the full transcript
        expect(r.output).toBe('kept');
        expect(r.meta?.subAgentId).toBe('verifier');
        expect(r.meta?.status).toBe('completed');
    });

    it('respects a custom input schema when provided', () => {
        const f = new DefaultSubAgentFactory(mockRunner(cannedState));
        const t = f.asTool({
            name: 'verify',
            description: 'verify',
            spec,
            inputSchema: {
                type: 'object',
                properties: { finding: { type: 'string' } },
                required: ['finding'],
            },
            toPrompt: (i: any) => i.finding,
            summarize: () => 'ok',
        });
        expect(t.inputSchema.required).toContain('finding');
    });
});
