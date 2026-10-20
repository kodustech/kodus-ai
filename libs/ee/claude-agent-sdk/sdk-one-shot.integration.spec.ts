/**
 * Single-shot Claude calls on the Agent SDK, through `LLM.run` exactly as the
 * 19 single-shot callers make them, against the real binary and the scripted
 * model server.
 */
import { z } from 'zod';

import { encrypt } from '@libs/common/utils/crypto';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { LLM } from '@libs/llm/llm';
import { setClaudeSdkExecutors } from '@libs/llm/sdk-executor-registry';
import { __limiterCacheInternals } from '@libs/llm/byok-to-vercel';

import { createClaudeSdkExecutors } from './executors';
import { SdkGateway } from './gateway/server';
import { SdkProcessPool } from './process-pool';
import { loadSdkRuntime } from './sdk-runtime';

const { startFakeLlmServer } = require('../../../evals/shared/fake-llm-server');

jest.setTimeout(90_000);

const KEY = 'sk-ant-upstream';
const Severity = z.object({ severity: z.enum(['low', 'high']), reason: z.string() });

describe('Claude single-shot calls on the Agent SDK (real binary)', () => {
    let fake: any;
    let gateway: SdkGateway;
    let pool: SdkProcessPool;
    let script: ((body: any, seq: number) => any) | undefined;

    // Structured calls keep today's per-model plan: Claude 5.x is 'reroute-json'
    // (schema in the prompt, JSON text back); older Claude is
    // 'suppress-thinking', which the CLI serves through its structured output.
    const slot = (model = 'claude-sonnet-5-5'): NormalizedModel => ({ provider: 'anthropic', model, apiKey: encrypt(KEY), baseURL: `${fake.origin}/v1` }) as unknown as NormalizedModel;
    const OLDER = 'claude-sonnet-4-5';
    const modelCalls = () => fake.calls.filter((c: any) => c.path === '/v1/messages');
    const viaCli = (c: any) => String(c.headers['anthropic-beta'] ?? '').includes('claude-code');
    const structuredTool = (b: any) => b.tools?.find((t: any) => t.name === 'StructuredOutput');

    beforeEach(async () => {
        __limiterCacheInternals.cache.clear();
        script = undefined;
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

    it('structured on Claude 5 (reroute-json): the schema in the prompt, the JSON text back as the object', async () => {
        script = (b) => (JSON.stringify(b.system ?? '').includes('conforms EXACTLY to this JSON Schema') ? { text: '{"severity":"high","reason":"deref"}' } : undefined);
        const out = await LLM.run({ byokConfig: slot(), runName: 'severity', system: 'Classify.', user: 'null deref in a.ts', schema: Severity });
        expect(out).toEqual({ severity: 'high', reason: 'deref' });
        const calls = modelCalls();
        expect(calls).toHaveLength(1);
        expect(calls.every(viaCli)).toBe(true);
        expect(calls[0].body.tools ?? []).toEqual([]);
    });

    it('structured on older Claude: one query, the schema through the CLI’s structured output, a valid object back', async () => {
        script = (b) => (structuredTool(b) ? { tool: structuredTool(b) } : undefined);
        const out = await LLM.run({ byokConfig: slot(OLDER), runName: 'severity', system: 'Classify.', user: 'null deref in a.ts', schema: Severity });
        expect(out).toEqual({ severity: 'low', reason: 'fake' });
        const calls = modelCalls();
        expect(calls.every(viaCli)).toBe(true);
        expect(calls[0].body.tools.map((t: any) => t.name)).toEqual(['StructuredOutput']);
        expect(calls[0].body.system.map((b: any) => b.text).join('')).toContain('Classify.');
    });

    it('structured: the CLI retries an invalid object itself, and the valid one comes back', async () => {
        script = (b, n) => {
            const tool = structuredTool(b);
            if (!tool) return undefined;
            return n === 1 ? { tool: { ...tool, input_schema: { type: 'object', properties: { severity: { const: 'medium' } } } } } : { tool };
        };
        expect(await LLM.run({ byokConfig: slot(OLDER), runName: 'severity', system: 's', user: 'u', schema: Severity })).toEqual({ severity: 'low', reason: 'fake' });
        expect(modelCalls().length).toBeGreaterThanOrEqual(2);
    });

    it('structured: an answer that never fits ends in the error LLM.run gives today, after the json_object re-issue', async () => {
        script = (b) => {
            const tool = structuredTool(b);
            return tool ? { tool: { ...tool, input_schema: { type: 'object', properties: { severity: { const: 'medium' } } } } } : { text: '{"severity":"medium"}' };
        };
        await expect(LLM.run({ byokConfig: slot(OLDER), runName: 'severity', system: 's', user: 'u', schema: Severity })).rejects.toThrow();
        // The re-issue went out with the schema written into the prompt.
        expect(modelCalls().some((c: any) => JSON.stringify(c.body.system ?? '').includes('conforms EXACTLY to this JSON Schema'))).toBe(true);
    });

    it('text: returns the model text exactly', async () => {
        script = () => ({ text: 'A summary.\nSecond line.' });
        expect(await LLM.run({ byokConfig: slot(), runName: 'pr-summary', system: 's', user: 'u' })).toBe('A summary.\nSecond line.');
        expect(modelCalls().every(viaCli)).toBe(true);
    });

    it('a non-Claude slot runs on generateText, untouched', async () => {
        const gpt = { provider: 'openai_compatible', model: 'gpt-x', apiKey: encrypt('k'), baseURL: `${fake.origin}/v1` } as unknown as NormalizedModel;
        expect(await LLM.run({ byokConfig: gpt, runName: 'pr-summary', system: 's', user: 'u' })).toBe('{}');
        expect(modelCalls()).toHaveLength(0);
        expect(fake.stats.byModel['gpt-x']).toBe(1);
    });
});
