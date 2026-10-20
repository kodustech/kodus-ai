/**
 * What the executors hand to `query()`, read through a runtime that records
 * the options instead of spawning the CLI: no built-in tool, no settings from
 * disk, the turn cap, the reasoning, and how a refusal before any request ends.
 */
const mockWarn = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ warn: (...a: unknown[]) => mockWarn(...a), error: jest.fn(), log: jest.fn(), info: jest.fn(), debug: jest.fn(), verbose: jest.fn() }),
}));

import { encrypt } from '@libs/common/utils/crypto';
import type { NormalizedModel } from '@libs/llm/byok-config';

import { SdkGateway } from './gateway/server';
import { SdkProcessPool } from './process-pool';
import { runClaudeSdkLoopCall } from './sdk-loop-call';
import { runClaudeSdkOneShot } from './sdk-one-shot';
import { isClaudeSdkInfraError } from './errors';
import { loadSdkRuntime } from './sdk-runtime';

const slot = { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: encrypt('k') } as unknown as NormalizedModel;

describe('options the executors give the SDK', () => {
    let gateway: SdkGateway;
    let pool: SdkProcessPool;
    let seen: any[];
    let answer: any;
    const runtime = () => ({
        ...loadSdkRuntime(),
        query: (args: any) => {
            seen.push(args.options);
            return (async function* () {
                yield answer;
            })();
        },
    });

    beforeEach(() => {
        gateway = new SdkGateway();
        pool = new SdkProcessPool(gateway, 2);
        seen = [];
        answer = { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, modelUsage: {} };
    });
    afterEach(async () => {
        await pool.shutdown();
        await gateway.close();
    });

    const loopCall = (over: any = {}) => ({
        slot,
        system: 's',
        messages: [{ role: 'user', content: 'go' }],
        loop: { tools: {}, maxSteps: 7, resultToolName: 'submitResult' },
        runName: 'finder',
        providerOptions: { anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } },
        ...over,
    });

    it('loop: no built-in tool, no settings from disk, no transcript, maxSteps + 1 turns, the slot reasoning', async () => {
        await runClaudeSdkLoopCall({ pool, runtime }, loopCall() as any);
        expect(seen[0]).toMatchObject({ model: 'claude-sonnet-5-5', tools: [], settingSources: [], persistSession: false, allowedTools: [], maxTurns: 8, thinking: { type: 'adaptive' }, effort: 'high' });
        expect(seen[0].env.ANTHROPIC_API_KEY).not.toBe('k');
    });

    it('one-shot: no tools, no settings, one turn for text and the schema through outputFormat', async () => {
        await runClaudeSdkOneShot({ pool, runtime }, { slot, prompt: 'p', runName: 'r' } as any);
        expect(seen[0]).toMatchObject({ tools: [], settingSources: [], allowedTools: [], maxTurns: 1, thinking: { type: 'disabled' } });
        expect(seen[0].outputFormat).toBeUndefined();
        await runClaudeSdkOneShot({ pool, runtime }, { slot, prompt: 'p', runName: 'r', jsonSchema: { type: 'object' } } as any);
        expect(seen[1].outputFormat).toEqual({ type: 'json_schema', schema: { type: 'object' } });
    });

    it('logs when the CLI counts different usage than the gateway, and stays quiet when they agree', async () => {
        mockWarn.mockClear();
        answer = { ...answer, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
        await runClaudeSdkLoopCall({ pool, runtime }, loopCall() as any);
        expect(mockWarn).not.toHaveBeenCalled();
        answer = { ...answer, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 40, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
        await runClaudeSdkLoopCall({ pool, runtime }, loopCall() as any);
        expect(mockWarn).toHaveBeenCalledWith(
            expect.objectContaining({ message: 'claude-sdk usage mismatch between gateway and CLI', metadata: expect.objectContaining({ runName: 'finder', cli: { input: 40, output: 7 } }) }),
        );
    });

    it('an error result with no request upstream (the CLI refused the model) is an infra failure, so the call falls back', async () => {
        answer = { type: 'result', subtype: 'success', is_error: true, result: 'There is an issue with the selected model', num_turns: 0 };
        const loopErr = await runClaudeSdkLoopCall({ pool, runtime }, loopCall() as any).catch((e) => e);
        expect(isClaudeSdkInfraError(loopErr) && loopErr.reason).toBe('model-rejected');
        const oneErr = await runClaudeSdkOneShot({ pool, runtime }, { slot, prompt: 'p', runName: 'r' } as any).catch((e) => e);
        expect(isClaudeSdkInfraError(oneErr) && oneErr.reason).toBe('model-rejected');
    });
});
