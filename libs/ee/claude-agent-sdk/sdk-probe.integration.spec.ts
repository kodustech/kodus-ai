/**
 * The doctor's SDK probe against the real binary and the scripted model
 * server: each hop fails on its own and is named.
 */
import type { NormalizedModel } from '@libs/llm/byok-config';
import { encrypt } from '@libs/common/utils/crypto';

import { SdkGateway } from './gateway/server';
import { SdkProcessPool } from './process-pool';
import { loadSdkRuntime, type SdkRuntime } from './sdk-runtime';
import { probeClaudeSdk } from './sdk-probe';

const { startFakeLlmServer } = require('../../../evals/shared/fake-llm-server');

jest.setTimeout(60_000);

const KEY = 'sk-ant-upstream';

describe('probeClaudeSdk (real binary)', () => {
    let fake: any;
    const slot = (): NormalizedModel => ({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: encrypt(KEY), baseURL: `${fake.origin}/v1` }) as unknown as NormalizedModel;
    const parts: Array<{ gateway: SdkGateway; pool: SdkProcessPool }> = [];
    const deps = (gw?: SdkGateway, runtime: () => SdkRuntime = loadSdkRuntime) => {
        const gateway = gw ?? new SdkGateway();
        const pool = new SdkProcessPool(gateway, 2);
        parts.push({ gateway, pool });
        return { pool, runtime };
    };

    beforeEach(async () => {
        fake = await startFakeLlmServer({ auth: { anthropicKey: KEY } });
    });
    afterEach(async () => {
        for (const p of parts.splice(0)) {
            await p.pool.shutdown();
            await p.gateway.close();
        }
        await fake.close();
    });

    it('all hops answer on a working slot', async () => {
        expect(await probeClaudeSdk(deps(), { slot: slot(), timeoutMs: 30_000 })).toEqual({ spawn: { ok: true }, gateway: { ok: true }, upstream: { ok: true, status: 200 } });
    });

    it('a binary that does not start is a spawn failure', async () => {
        const broken = () => {
            const rt = loadSdkRuntime();
            return { ...rt, query: (a: any) => rt.query({ ...a, options: { ...a.options, pathToClaudeCodeExecutable: '/nonexistent/claude' } }) };
        };
        const r = await probeClaudeSdk(deps(undefined, broken), { slot: slot(), timeoutMs: 30_000 });
        expect(r.spawn.ok).toBe(false);
        expect(r.gateway).toEqual({ ok: false, error: 'not reached' });
    });

    it('an upstream the gateway cannot reach is a gateway failure', async () => {
        const unreachable = new SdkGateway({ fetch: (async () => { throw new Error('connect ECONNREFUSED'); }) as any });
        const r = await probeClaudeSdk(deps(unreachable), { slot: slot(), timeoutMs: 30_000 });
        expect(r.spawn.ok).toBe(true);
        expect(r.gateway.ok).toBe(false);
        expect(r.gateway.error).toContain('ECONNREFUSED');
    });

    it('a provider refusal is an upstream failure with its status and body', async () => {
        fake.failNext({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
        const r = await probeClaudeSdk(deps(), { slot: slot(), timeoutMs: 30_000 });
        expect(r).toMatchObject({ spawn: { ok: true }, gateway: { ok: true }, upstream: { ok: false, status: 401 } });
        expect(r.upstream.error).toContain('invalid x-api-key');
    });

    it('a slot that does not run on the SDK says so', async () => {
        const gpt = { provider: 'openai', model: 'gpt-5.4', apiKey: encrypt('k') } as unknown as NormalizedModel;
        expect((await probeClaudeSdk(deps(), { slot: gpt, timeoutMs: 1000 })).spawn).toEqual({ ok: false, error: 'this model does not run on the Claude Agent SDK' });
    });
});
