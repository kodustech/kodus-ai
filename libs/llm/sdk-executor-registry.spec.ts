/**
 * The core's side of #2113: with no executor registered (community self-hosted,
 * a bare test) every call is today's `generateText` call, byte for byte; with
 * one registered, an eligible slot's call goes to it inside the same span, and
 * a runtime failure before its first step reruns on `generateText`. The core
 * never imports the SDK or EE code (lint rule, checked here).
 */
jest.mock('ai', () => {
    const actual = jest.requireActual('ai');
    return { ...actual, generateText: jest.fn() };
});
const mockWarn = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ warn: (...a: unknown[]) => mockWarn(...a), error: jest.fn(), log: jest.fn(), info: jest.fn(), debug: jest.fn(), verbose: jest.fn() }),
}));

import { generateText } from 'ai';
import { Linter } from 'eslint';
import path from 'node:path';

import { runAgentLoopCall } from '@libs/llm/agent-loop-call';
import { setLlmObservability } from '@libs/llm/llm-observability';
import {
    getClaudeSdkExecutors,
    sdkExecutorsFor,
    setClaudeSdkExecutors,
    withSdkInfraFallback,
    type ClaudeSdkExecutors,
} from '@libs/llm/sdk-executor-registry';
import type { NormalizedModel } from '@libs/llm/byok-config';

const mockGenerate = generateText as unknown as jest.Mock;
const AI_RESULT = { text: 'ai', steps: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
const SDK_RESULT = { text: 'sdk', steps: [], usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } };

const claude = { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: '' } as unknown as NormalizedModel;
const gpt = { provider: 'openai', model: 'gpt-5.4', apiKey: '' } as unknown as NormalizedModel;

class Infra extends Error {
    reason = 'spawn';
}

function executors(over: Partial<ClaudeSdkExecutors> = {}): ClaudeSdkExecutors & { runLoop: jest.Mock } {
    return {
        eligible: (slot) => slot?.provider === 'anthropic',
        runLoop: jest.fn(async () => SDK_RESULT),
        runOneShot: jest.fn(),
        isInfraFailure: (e) => e instanceof Infra,
        ...over,
    } as any;
}

const loopParams = (slot: NormalizedModel | undefined) => ({
    byokConfig: slot,
    system: 'sys',
    messages: [{ role: 'user' as const, content: 'go' }],
    loop: { tools: {}, maxSteps: 3, onStepFinish: jest.fn() },
    runName: 'finder',
    organizationId: 'org-1',
    signal: new AbortController().signal,
});

/** The generateText request without its function-valued fields (closures differ per call). */
const request = () => JSON.stringify(mockGenerate.mock.calls[mockGenerate.mock.calls.length - 1][0], (k, v) => (typeof v === 'function' ? `[fn ${k}]` : k === 'abortSignal' ? '[signal]' : v));

describe('sdk executor registry', () => {
    beforeEach(() => {
        mockGenerate.mockReset();
        mockGenerate.mockResolvedValue(AI_RESULT);
    });
    afterEach(() => {
        setClaudeSdkExecutors(undefined);
        setLlmObservability(undefined);
    });

    it('unset: every slot, Claude included, runs generateText', async () => {
        expect(getClaudeSdkExecutors()).toBeUndefined();
        expect(sdkExecutorsFor(claude)).toBeUndefined();
        expect(await runAgentLoopCall(loopParams(claude) as any)).toBe(AI_RESULT);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it('a slot the executor does not take sends today’s request byte for byte', async () => {
        await runAgentLoopCall(loopParams(gpt) as any);
        const without = request();
        const ex = executors();
        setClaudeSdkExecutors(ex);
        await runAgentLoopCall(loopParams(gpt) as any);
        expect(request()).toBe(without);
        expect(ex.runLoop).not.toHaveBeenCalled();
    });

    it('an eligible slot runs on the executor, inside the one usage span, with the call’s config', async () => {
        const ex = executors();
        setClaudeSdkExecutors(ex);
        const spans: any[] = [];
        setLlmObservability({
            runAiSdkLLMInSpan: async (p: any) => {
                spans.push(p);
                return p.exec();
            },
        });
        const params = loopParams(claude);
        expect(await runAgentLoopCall({ ...params, maxOutputTokens: 4000, temperature: 0.3 } as any)).toBe(SDK_RESULT);
        expect(mockGenerate).not.toHaveBeenCalled();
        expect(spans).toHaveLength(1);
        expect(spans[0]).toMatchObject({ spanName: 'finder', runName: 'finder' });
        const call = ex.runLoop.mock.calls[0][0];
        expect(call).toMatchObject({ slot: claude, system: 'sys', runName: 'finder', organizationId: 'org-1', maxOutputTokens: 4000, temperature: 0.3, signal: params.signal });
        expect(call.messages).toEqual(params.messages);
        expect(call.loop.maxSteps).toBe(3);
    });

    it('a runtime failure before the first step reruns on generateText; after it, the error stands', async () => {
        setClaudeSdkExecutors(executors({ runLoop: jest.fn(async () => Promise.reject(new Infra('spawn'))) as any }));
        expect(await runAgentLoopCall(loopParams(claude) as any)).toBe(AI_RESULT);

        setClaudeSdkExecutors(
            executors({
                runLoop: jest.fn(async (c: any) => {
                    await c.loop.onStepFinish({ text: '', toolCalls: [] });
                    throw new Infra('crash');
                }) as any,
            }),
        );
        mockGenerate.mockClear();
        await expect(runAgentLoopCall(loopParams(claude) as any)).rejects.toBeInstanceOf(Infra);
        expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('a provider error is never rerun on generateText', async () => {
        const providerError = Object.assign(new Error('invalid x-api-key'), { statusCode: 401 });
        setClaudeSdkExecutors(executors({ runLoop: jest.fn(async () => Promise.reject(providerError)) as any }));
        await expect(runAgentLoopCall(loopParams(claude) as any)).rejects.toBe(providerError);
        expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('an executor whose eligibility check throws is treated as not taking the slot', () => {
        setClaudeSdkExecutors(executors({ eligible: () => { throw new Error('boom'); } }));
        expect(sdkExecutorsFor(claude)).toBeUndefined();
    });

    it('logs the fallback with the run, the org and the reason', async () => {
        mockWarn.mockClear();
        const out = await withSdkInfraFallback({
            executors: executors(),
            runSdk: () => Promise.reject(new Infra('spawn')),
            runAiSdk: async () => 'ai',
            started: () => false,
            runName: 'severity',
            organizationId: 'org-9',
            slot: claude,
        });
        expect(out).toBe('ai');
        expect(mockWarn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'claude-sdk-infra-fallback',
                metadata: expect.objectContaining({ runName: 'severity', organizationId: 'org-9', provider: 'anthropic', model: 'claude-sonnet-5-5', reason: 'spawn' }),
            }),
        );
    });

    it('lint: the LLM core cannot import the SDK or EE code, and no core file can import the SDK', () => {
        const root = path.resolve(__dirname, '../..');
        // The repo's own flat config, minus the type-aware project (the probe
        // files are not on disk): the import rules need no type information.
        const config = (require(path.join(root, 'eslint.config.js')) as any[]).map((c) =>
            c.languageOptions?.parserOptions?.project
                ? { ...c, languageOptions: { ...c.languageOptions, parserOptions: { ...c.languageOptions.parserOptions, project: undefined } } }
                : c,
        );
        const linter = new Linter({ cwd: root });
        const restricted = (code: string, file: string) =>
            linter.verify(code, config, path.join(root, file)).filter((m) => m.ruleId === 'no-restricted-imports').length;
        const sdkImport = "import { query } from '@anthropic-ai/claude-agent-sdk';\nexport const q = query;\n";
        expect(restricted(sdkImport, 'libs/llm/registry-probe.ts')).toBe(1);
        expect(restricted("import { x } from '@libs/ee/claude-agent-sdk/executors';\nexport const y = x;\n", 'libs/llm/registry-probe.ts')).toBe(1);
        expect(restricted(sdkImport, 'libs/code-review/probe.ts')).toBe(1);
        expect(restricted(sdkImport, 'apps/worker/src/probe.ts')).toBe(1);
        expect(restricted(sdkImport, 'libs/ee/claude-agent-sdk/probe.ts')).toBe(0);
    });
});
