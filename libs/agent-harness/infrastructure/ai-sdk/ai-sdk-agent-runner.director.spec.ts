/**
 * The loop director (#2113) carries the policies to a runtime that owns its own
 * loop. It must say, at every step, what `prepareStep` injects on the AI SDK
 * path: the same note, the same active tools, and the same stop verdict — so
 * the eval compares runtimes, not policies.
 *
 * Each side runs on its own fresh policy instances (Budget is stateful: it
 * notes only band transitions), stepped through the same sequence.
 */
jest.mock('@libs/llm/llm', () => ({ LLM: { run: jest.fn() } }));

import { LLM } from '@libs/llm/llm';
import type { LoopDirector } from '@libs/llm/agent-loop-call';

import type { AgentPolicy } from '../../domain/contracts/policy.contract';
import type { AgentTool, ToolContext } from '../../domain/contracts/tool.contract';
import { InMemoryToolRegistry } from '../tools/in-memory-tool-registry';
import { BudgetPolicy } from '../policies/budget.policy';
import { ForceFinalizePolicy } from '../policies/force-finalize.policy';
import { ForceTextFinalizePolicy } from '../policies/force-text-finalize.policy';
import { CompletionGatePolicy } from '../policies/completion-gate.policy';
import { CompressionPolicy } from '../policies/compression.policy';
import { AiSdkAgentRunner } from './ai-sdk-agent-runner';

const mockRun = LLM.run as jest.Mock;

const tool = (name: string): AgentTool => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, execute: async () => ({ output: 'ok' }) });
const ctx: ToolContext = { runId: 'r' };
const MAX_STEPS = 12;

// A ledger with one open critical target, so the completion gate has debt to note.
function gateLedger() {
    return {
        debtNote: () => 'PROGRESS: 1 critical target not yet verified: a.ts:10.',
        summary: () => ({ total: 1, done: 0, critical: 1, criticalOpen: 1 }),
        hasOpenCritical: () => true,
        markFromToolCall: () => undefined,
    } as any;
}

async function seams(policies: () => AgentPolicy[], resultToolName?: string) {
    let loop: any;
    mockRun.mockImplementationOnce(async (req: any) => {
        loop = req.loop;
        return { usage: {}, steps: [], text: '' };
    });
    await new AiSdkAgentRunner(undefined).run(
        { id: 'finder', systemPrompt: 's', tools: new InMemoryToolRegistry([tool('readFile'), tool('submitResult')]), policies: policies(), maxSteps: MAX_STEPS, resultToolName } as any,
        { prompt: 'review' },
        ctx,
    );
    return loop as { prepareStep: (o: any) => Promise<any>; stopWhen: Array<(o: any) => Promise<boolean>>; director: LoopDirector; resultToolName?: string };
}

/** What prepareStep injected at a step: the trailing note and the active tools. */
function injected(out: any, before: number) {
    const msgs = out.messages as any[] | undefined;
    const note = msgs && msgs.length > before ? msgs[msgs.length - 1].content : undefined;
    return { note, activeTools: out.activeTools };
}

describe('AiSdkAgentRunner loop director', () => {
    afterEach(() => mockRun.mockReset());

    const POLICY_SETS: Array<[string, () => AgentPolicy[]]> = [
        ['budget', () => [new BudgetPolicy()]],
        ['force-finalize', () => [new ForceFinalizePolicy({ doneToolName: 'submitResult' })]],
        ['force-text-finalize', () => [new ForceTextFinalizePolicy({ answerDescription: 'your verdict' })]],
        ['completion-gate', () => [new CompletionGatePolicy(gateLedger(), { doneToolName: 'submitResult' })]],
        [
            'finder stack',
            () => [new BudgetPolicy(), new CompletionGatePolicy(gateLedger(), { doneToolName: 'submitResult' }), new ForceFinalizePolicy({ doneToolName: 'submitResult' })],
        ],
    ];

    it.each(POLICY_SETS)('%s: same note and active tools as prepareStep at every step', async (_name, policies) => {
        const aiSdk = await seams(policies);
        const sdk = await seams(policies);
        const base = [{ role: 'user', content: 'review' }];
        for (let step = 0; step < MAX_STEPS; step++) {
            const want = injected(await aiSdk.prepareStep({ stepNumber: step, messages: base }), base.length);
            const got = await sdk.director.beforeStep(step);
            expect({ step, note: got.note, activeTools: got.activeTools }).toEqual({ step, note: want.note, activeTools: want.activeTools });
        }
    });

    it('gives the same stop verdict as stopWhen', async () => {
        let stop = false;
        const stopper = (): AgentPolicy[] => [{ name: 'stopper', shouldStop: () => stop }];
        const aiSdk = await seams(stopper);
        const sdk = await seams(stopper);
        expect(await sdk.director.shouldStop(3)).toBe(await aiSdk.stopWhen[0]({ steps: new Array(3) }));
        stop = true;
        expect(await sdk.director.shouldStop(4)).toBe(true);
        expect(await aiSdk.stopWhen[0]({ steps: new Array(4) })).toBe(true);
    });

    it('finalize gives the last step’s directive whatever step the run ends at, and null with no finalize policy', async () => {
        const sdk = await seams(() => [new ForceFinalizePolicy({ doneToolName: 'submitResult' })], 'submitResult');
        expect(sdk.resultToolName).toBe('submitResult');
        const early = await sdk.director.finalize(2);
        expect(early).toEqual({
            note: 'You are at the final step. Call submitResult now with the findings you have — do not investigate further.',
            activeTools: ['submitResult'],
        });
        expect(await sdk.director.finalize(MAX_STEPS)).toEqual(early);
        const none = await seams(() => []);
        expect(await none.director.finalize(2)).toBeNull();
    });

    it('reports a message-window replacement (compression) as unsupported instead of applying it', async () => {
        const compressor = { maybeCompress: () => ({ messages: [{ role: 'user', content: 'compressed' }], stats: {} }) } as any;
        const sdk = await seams(() => [new CompressionPolicy(compressor)]);
        expect(await sdk.director.beforeStep(5)).toEqual({ unsupported: ['messages'] });
    });

    it('is absent from nothing the AI SDK path reads: the seams it already had are unchanged', async () => {
        const loop = await seams(() => [new BudgetPolicy()]);
        expect(Object.keys(loop).sort()).toEqual(['director', 'maxSteps', 'onStepFinish', 'prepareStep', 'stopWhen', 'tools']);
    });
});
