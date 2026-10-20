/**
 * An agent loop on the Claude Agent SDK, end to end: AiSdkAgentRunner → LLM.run
 * → runAgentLoopCall → the registered executor → the real `claude` binary →
 * the gateway → the scripted model server. The same specs run on today's
 * path (registry unset, @ai-sdk/anthropic against the same server) for the
 * RunState comparison.
 */
import { encrypt } from '@libs/common/utils/crypto';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { setClaudeSdkExecutors } from '@libs/llm/sdk-executor-registry';
import { __limiterCacheInternals } from '@libs/llm/byok-to-vercel';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import { ForceFinalizePolicy } from '@libs/agent-harness/infrastructure/policies/force-finalize.policy';
import type { AgentPolicy } from '@libs/agent-harness/domain/contracts/policy.contract';
import type { AgentTool } from '@libs/agent-harness/domain/contracts/tool.contract';

import { createClaudeSdkExecutors } from './executors';
import { ClaudeSdkInfraError } from './errors';
import { SdkGateway } from './gateway/server';
import { SdkProcessPool } from './process-pool';
import { loadSdkRuntime } from './sdk-runtime';

const { startFakeLlmServer } = require('../../../evals/shared/fake-llm-server');

jest.setTimeout(90_000);

const KEY = 'sk-ant-upstream';
const SUBMIT_SCHEMA: any = {
    type: 'object',
    properties: { reasoning: { type: 'string' }, suggestions: { type: 'array', items: { type: 'object', properties: { relevantFile: { type: 'string' } } } } },
    required: ['reasoning', 'suggestions'],
};

describe('Claude loop on the Agent SDK (real binary)', () => {
    let fake: any;
    let gateway: SdkGateway;
    let pool: SdkProcessPool;
    let script: ((body: any, seq: number) => any) | undefined;
    let reads: string[];

    const slot = (): NormalizedModel => ({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: encrypt(KEY), baseURL: `${fake.origin}/v1` }) as unknown as NormalizedModel;

    const tools = (): AgentTool[] => [
        {
            name: 'readFile',
            description: 'Read a file.',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            execute: async (i: any) => {
                reads.push(i.path);
                return { output: `contents of ${i.path}` };
            },
        },
        { name: 'submitResult', description: 'Submit the findings.', inputSchema: SUBMIT_SCHEMA, execute: async () => ({ output: 'recorded' }) },
    ];

    const spec = (over: Record<string, unknown> = {}) =>
        ({ id: 'finder', systemPrompt: 'Review the change, then call submitResult.', tools: new InMemoryToolRegistry(tools()), policies: [], maxSteps: 8, resultToolName: 'submitResult', ...over }) as any;

    const run = (s = spec(), signal?: AbortSignal, slotOver?: NormalizedModel) =>
        new AiSdkAgentRunner(slotOver ?? slot(), { organizationId: 'org-1' }).run(s, { prompt: 'Review a.ts' }, { runId: 'r1', signal } as any);

    const modelCalls = () => fake.calls.filter((c: any) => c.path === '/v1/messages');
    const viaCli = (c: any) => String(c.headers['anthropic-beta'] ?? '').includes('claude-code');

    beforeEach(async () => {
        __limiterCacheInternals.cache.clear();
        script = undefined;
        reads = [];
        fake = await startFakeLlmServer({ auth: { anthropicKey: KEY }, anthropicScript: (b: any, n: number) => script?.(b, n) });
        gateway = new SdkGateway();
        pool = new SdkProcessPool(gateway, 4);
        setClaudeSdkExecutors(createClaudeSdkExecutors({ pool, runtime: loadSdkRuntime }));
    });

    afterEach(async () => {
        setClaudeSdkExecutors(undefined);
        await pool.shutdown();
        await gateway.close();
        await fake.close();
    });

    it('runs the tool loop in Claude’s loop: our tools in-process over MCP, no built-in, the result tool as the artifact', async () => {
        const state = await run();
        expect(state.status).toBe('completed');
        expect(state.steps.map((s) => (s.message.toolCalls ?? []).map((t) => t.name))).toEqual([['readFile'], ['submitResult'], []]);
        expect(reads).toEqual(['fake']);
        expect(state.artifacts).toEqual([{ type: 'submitResult', payload: { reasoning: 'fake', suggestions: [{ relevantFile: 'fake' }] }, location: 'step:1', stage: 'result' }]);
        const calls = modelCalls();
        expect(calls.every(viaCli)).toBe(true);
        expect(calls.every((c: any) => c.headers['x-api-key'] === KEY)).toBe(true);
        expect(calls[0].body.tools.map((t: any) => t.name).sort()).toEqual(['mcp__kodus__readFile', 'mcp__kodus__submitResult']);
        expect(calls[0].body.system.map((b: any) => b.text).join('')).toContain('Review the change, then call submitResult.');
        expect(state.usage).toMatchObject({ inputTokens: 300, outputTokens: 30 });
    });

    it('gives the runner the same RunState shape as today’s path for the same model answers', async () => {
        const sdk = await run();
        setClaudeSdkExecutors(undefined);
        const before = modelCalls().length;
        const today = await run();
        expect(modelCalls().slice(before).some(viaCli)).toBe(false);
        const shape = (s: any) => ({
            status: s.status,
            steps: s.steps.map((st: any) => ({ tools: (st.message.toolCalls ?? []).map((t: any) => [t.name, t.input]), text: st.message.content })),
            artifacts: s.artifacts,
        });
        expect(shape(sdk)).toEqual(shape(today));
    });

    it('puts a policy note in the next request and denies a tool outside the active set', async () => {
        const steering: AgentPolicy = {
            name: 'steer',
            prepareStep: (v) => (v.stepNumber === 0 ? { activeTools: ['submitResult'], injectNote: { role: 'user', content: 'NOTE-7f3a: submit now.' } } : {}),
        };
        script = (b) => {
            const results = b.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((c: any) => c.type === 'tool_result');
            if (!results.length) return { tool: b.tools.find((t: any) => t.name === 'mcp__kodus__readFile') };
            return undefined;
        };
        const state = await run(spec({ policies: [steering] }));
        expect(reads).toEqual([]);
        const second = modelCalls()[1].body;
        const denied = second.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).find((c: any) => c.type === 'tool_result');
        expect(JSON.stringify(denied)).toContain('readFile is not available at this step. NOTE-7f3a: submit now.');
        expect(JSON.stringify(modelCalls()[0].body)).toContain('NOTE-7f3a');
        expect(state.artifacts.map((a) => a.type)).toEqual(['submitResult']);
    });

    it('without the result tool: Stop blocks once with the finalize note, then the last JSON in the text becomes the result', async () => {
        script = () => ({ text: 'Found one.\n```json\n{"reasoning":"r","suggestions":[{"relevantFile":"a.ts"}]}\n```' });
        const state = await run(spec({ policies: [new ForceFinalizePolicy({ doneToolName: 'submitResult' })] }));
        const calls = modelCalls();
        expect(calls).toHaveLength(2);
        expect(JSON.stringify(calls[1].body.messages)).toContain('Call submitResult now with the findings you have');
        expect(state.artifacts).toEqual([
            { type: 'submitResult', payload: { reasoning: 'r', suggestions: [{ relevantFile: 'a.ts' }] }, location: `step:${state.steps.length - 1}`, stage: 'result' },
        ]);
    });

    it('stops at maxSteps as budget-exhausted', async () => {
        script = (b) => ({ tool: b.tools.find((t: any) => t.name === 'mcp__kodus__readFile') });
        const state = await run(spec({ maxSteps: 3 }));
        expect(state.status).toBe('budget-exhausted');
        expect(state.steps.length).toBeGreaterThanOrEqual(3);
        expect(modelCalls().length).toBeLessThanOrEqual(4);
    });

    it('a provider error surfaces as today: the runner’s error state with the status, nothing retried on another runtime', async () => {
        fake.failNext({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
        const state = await run();
        expect(state.status).toBe('error');
        // The CLI retries; the provider still sees the one request today's path makes.
        expect(modelCalls()).toHaveLength(1);
        expect(state.trace.find((t) => t.kind === 'error')?.detail).toMatchObject({ status: 401 });
        expect(modelCalls().some((c: any) => !viaCli(c))).toBe(false);
    });

    it('a runtime failure before the first step reruns the call on generateText', async () => {
        setClaudeSdkExecutors(
            createClaudeSdkExecutors({
                pool,
                runtime: () => {
                    throw new ClaudeSdkInfraError('spawn', 'binary missing');
                },
            }),
        );
        const state = await run();
        expect(state.status).toBe('completed');
        expect(state.artifacts.map((a) => a.type)).toEqual(['submitResult']);
        expect(modelCalls().length).toBeGreaterThan(0);
        expect(modelCalls().some(viaCli)).toBe(false);
    });

    it('aborts with the caller’s signal and leaves no session behind', async () => {
        script = (b) => ({ tool: b.tools.find((t: any) => t.name === 'mcp__kodus__readFile') });
        const controller = new AbortController();
        const slow = tools();
        slow[0].execute = async () => {
            controller.abort();
            await new Promise((r) => setTimeout(r, 200));
            return { output: 'late' };
        };
        const t0 = Date.now();
        const state = await run(spec({ tools: new InMemoryToolRegistry(slow), maxSteps: 50 }), controller.signal);
        expect(state.status).toBe('error');
        expect(Date.now() - t0).toBeLessThan(15_000);
        expect(gateway.liveSessions).toBe(0);
        expect(pool.inUse).toBe(0);
    });

    it('a Claude 401 before the first step fails over to the slot’s non-Claude fallback on generateText', async () => {
        fake.failNext({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
        const primary = slot();
        (primary as any).fallback = { provider: 'openai_compatible', model: 'gpt-fallback', apiKey: encrypt('x'), baseURL: `${fake.origin}/v1` };
        const state = await run(spec(), undefined, primary);
        // The OpenAI script keeps calling the done tool (in production the
        // completion gate stops there), so the run ends on its step budget.
        expect(state.status).not.toBe('error');
        expect(fake.stats.byModel['gpt-fallback']).toBeGreaterThan(0);
        expect(state.artifacts[0]?.type).toBe('submitResult');
        expect(modelCalls().filter(viaCli)).toHaveLength(1);
    });
});
