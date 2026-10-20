/**
 * The subprocess pool with the real `claude` binary of the pinned SDK, talking
 * to the scripted model server through the gateway. No key, no network.
 */
import { existsSync } from 'node:fs';

import type { NormalizedModel } from '@libs/llm/byok-config';

import { SdkGateway } from './gateway/server';
import { defaultPoolCapacity, SdkProcessPool, type SdkSession, type SdkSessionRequest } from './process-pool';
import { loadSdkRuntime } from './sdk-runtime';
import { isClaudeSdkInfraError } from './errors';

const { startFakeLlmServer } = require('../../../evals/shared/fake-llm-server');

jest.setTimeout(120_000);

const KEY = 'upstream-key';

describe('SdkProcessPool (real binary)', () => {
    const rt = loadSdkRuntime();
    let fake: any;
    let gateway: SdkGateway;

    const request = (over: Partial<SdkSessionRequest> = {}): SdkSessionRequest => ({
        resolved: { model: 'claude-sonnet-5-5', route: { format: 'anthropic', baseUrl: fake.origin, apiKey: KEY, auth: 'x-api-key', firstParty: true } },
        envelope: { slot: { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'enc' } as unknown as NormalizedModel, organizationId: 'org-1' },
        ...over,
    });

    async function ask(s: SdkSession): Promise<any[]> {
        const out: any[] = [];
        for await (const m of rt.query({
            prompt: 'hello',
            options: {
                model: s.model,
                systemPrompt: 'answer briefly',
                tools: [],
                settingSources: [],
                persistSession: false,
                cwd: s.home,
                env: s.env,
                maxTurns: 1,
                abortController: s.abortController,
                spawnClaudeCodeProcess: s.spawn,
            },
        })) {
            out.push(m);
        }
        return out;
    }

    beforeEach(async () => {
        fake = await startFakeLlmServer({ auth: { anthropicKey: KEY } });
        gateway = new SdkGateway();
    });

    afterEach(async () => {
        await gateway.close();
        await fake.close();
    });

    it('runs a query through the gateway, then removes the session directory and revokes the token', async () => {
        const pool = new SdkProcessPool(gateway, 2);
        let seen!: SdkSession;
        const messages = await pool.withSession(request(), async (s) => {
            seen = s;
            expect(existsSync(s.home)).toBe(true);
            return ask(s);
        });
        expect(messages.find((m) => m.type === 'result')?.subtype).toBe('success');
        expect(fake.calls.find((c: any) => c.path === '/v1/messages').headers['x-api-key']).toBe(KEY);
        expect(existsSync(seen.home)).toBe(false);
        expect(gateway.liveSessions).toBe(0);
        const r = await fetch(`${seen.gateway.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
        expect(r.status).toBe(401);
    });

    it('cleans up the same way when fn throws', async () => {
        const pool = new SdkProcessPool(gateway, 1);
        let home = '';
        await expect(
            pool.withSession(request(), async (s) => {
                home = s.home;
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        expect(existsSync(home)).toBe(false);
        expect(gateway.liveSessions).toBe(0);
        expect(pool.inUse).toBe(0);
    });

    it('queues beyond the cap and times out as an infra error under the queue timeout', async () => {
        const pool = new SdkProcessPool(gateway, 1);
        let release!: () => void;
        const first = pool.withSession(request(), () => new Promise<void>((r) => (release = r)));
        await new Promise((r) => setTimeout(r, 20));
        const second = pool.withSession(request(), async () => 'second');
        await new Promise((r) => setTimeout(r, 20));
        expect({ inUse: pool.inUse, queued: pool.queued }).toEqual({ inUse: 1, queued: 1 });
        release();
        await first;
        await expect(second).resolves.toBe('second');

        let hold!: () => void;
        const busy = pool.withSession(request(), () => new Promise<void>((r) => (hold = r)));
        await new Promise((r) => setTimeout(r, 20));
        const err = await pool.withSession(request({ queueTimeoutMs: 50 }), async () => 'never').catch((e) => e);
        expect(isClaudeSdkInfraError(err) && err.reason).toBe('queue-timeout');
        hold();
        await busy;
    });

    it('on the caller’s abort, the subprocess is gone within 5 s and everything is cleaned up', async () => {
        // An upstream that never answers: the CLI waits on it until aborted.
        const stalled = new SdkGateway({ fetch: ((_u: any, init: any) => new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch });
        const pool = new SdkProcessPool(stalled, 1);
        const controller = new AbortController();
        let home = '';
        let pid: number | undefined;
        const run = pool.withSession(request({ signal: controller.signal }), async (s) => {
            home = s.home;
            const spawn = s.spawn;
            s.spawn = (o) => {
                const c = spawn(o);
                pid = c.pid;
                return c;
            };
            return ask(s).catch((e) => e);
        });
        // Wait until the request reached the gateway.
        for (let i = 0; i < 100 && stalled.liveSessions === 0; i++) await new Promise((r) => setTimeout(r, 50));
        await new Promise((r) => setTimeout(r, 1500));
        const t0 = Date.now();
        controller.abort();
        await run;
        expect(Date.now() - t0).toBeLessThan(5_500);
        expect(pid).toBeDefined();
        expect(() => process.kill(pid!, 0)).toThrow();
        expect(existsSync(home)).toBe(false);
        expect(stalled.liveSessions).toBe(0);
        await stalled.close();
    });

    it('shutdown aborts live sessions, rejects the queue and refuses new work', async () => {
        const pool = new SdkProcessPool(gateway, 1);
        const live = pool.withSession(
            request(),
            (s) =>
                new Promise((_r, reject) => {
                    if (s.abortController.signal.aborted) return reject(new Error('aborted by shutdown'));
                    s.abortController.signal.addEventListener('abort', () => reject(new Error('aborted by shutdown')));
                }),
        );
        await new Promise((r) => setTimeout(r, 20));
        const queued = pool.withSession(request(), async () => 'never').catch((e) => e);
        const liveErr = live.catch((e) => e);
        await pool.shutdown();
        expect(((await liveErr) as Error).message).toBe('aborted by shutdown');
        expect(isClaudeSdkInfraError(await queued)).toBe(true);
        expect(isClaudeSdkInfraError(await pool.withSession(request(), async () => 1).catch((e) => e))).toBe(true);
        expect(gateway.liveSessions).toBe(0);
    });

    it('sizes the cap from memory: ~220 MB per subprocess, half the machine, 2 to 32', () => {
        const GB = 1024 ** 3;
        expect(defaultPoolCapacity(2 * GB)).toBe(4);
        expect(defaultPoolCapacity(8 * GB)).toBe(18);
        expect(defaultPoolCapacity(0.5 * GB)).toBe(2);
        expect(defaultPoolCapacity(64 * GB)).toBe(32);
    });
});
