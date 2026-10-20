/**
 * The gateway between a Claude Agent SDK subprocess and the slot's upstream,
 * driven by clients we did not write (Anthropic's SDK, the AI SDK's Vertex
 * provider, AWS's event-stream codec) against the scripted model server.
 */
import Anthropic from '@anthropic-ai/sdk';
import { EventStreamCodec } from '@smithy/eventstream-codec';
import { fromUtf8, toUtf8 } from '@smithy/util-utf8';

import type { NormalizedModel } from '@libs/llm/byok-config';
import { __limiterCacheInternals, getLimiterForSlot } from '@libs/llm/byok-to-vercel';
import { LlmErrorCategory } from '@libs/llm/error-classifier';
import { setLlmObservability } from '@libs/llm/llm-observability';

import { SdkGateway, type GatewaySessionParams } from './server';
import type { AnthropicFormatRoute, BedrockRoute, VertexRoute } from '../route';

const { startFakeLlmServer } = require('../../../../evals/shared/fake-llm-server');

const UPSTREAM_KEY = 'sk-ant-real-upstream-key';
const slot = (extra: Partial<NormalizedModel> = {}) =>
    ({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: `enc-${Math.random()}`, ...extra }) as unknown as NormalizedModel;

describe('SdkGateway', () => {
    let fake: any;
    let gateway: SdkGateway;
    const anthropicRoute = (): AnthropicFormatRoute => ({ format: 'anthropic', baseUrl: fake.origin, apiKey: UPSTREAM_KEY, auth: 'x-api-key', firstParty: true });
    const open = (p: Partial<GatewaySessionParams> = {}) => gateway.openSession({ route: anthropicRoute(), envelope: { slot: slot(), organizationId: 'org-1', provider: 'anthropic' }, ...p });
    const client = (baseUrl: string, apiKey = 'session-has-no-key') => new Anthropic({ apiKey, baseURL: baseUrl, maxRetries: 0 });
    const ask = (baseUrl: string, body: Record<string, unknown> = {}) =>
        client(baseUrl).messages.create({ model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'review a.ts' }], ...body } as any);

    beforeEach(async () => {
        __limiterCacheInternals.cache.clear();
        fake = await startFakeLlmServer({ auth: { anthropicKey: UPSTREAM_KEY, vertexToken: 'sa-access-token', bedrockToken: 'br-api-key' } });
        gateway = new SdkGateway({ vertexToken: async () => 'sa-access-token' });
    });

    afterEach(async () => {
        await gateway.close();
        await fake.close();
        setLlmObservability(undefined);
    });

    describe('server and sessions', () => {
        it('listens on 127.0.0.1 on a port the OS picked, and starts once', async () => {
            await gateway.start();
            await gateway.start();
            expect(gateway.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
            expect(Number(gateway.origin.split(':')[2])).toBeGreaterThan(0);
        });

        it('rejects an unknown token and a revoked one with 401, and serves a live one', async () => {
            const s = await open();
            const err = await ask(`${gateway.origin}/s/${'0'.repeat(48)}`).catch((e) => e);
            expect(err.status).toBe(401);
            expect((await ask(s.baseUrl)).stop_reason).toBe('end_turn');
            s.close();
            expect((await ask(s.baseUrl).catch((e) => e)).status).toBe(401);
            expect(gateway.liveSessions).toBe(0);
        });

        it('close() revokes every session and frees the port', async () => {
            const s = await open();
            const origin = gateway.origin;
            await gateway.close();
            await expect(fetch(`${origin}/s/${s.token}/v1/messages`, { method: 'POST', body: '{}' })).rejects.toThrow();
            expect(gateway.liveSessions).toBe(0);
        });
    });

    describe('Anthropic format', () => {
        it('injects the slot key upstream and forwards the body byte for byte', async () => {
            const s = await open();
            const raw = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'x' }], metadata: { user_id: 'u' } });
            const r = await fetch(`${s.baseUrl}/v1/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-api-key': s.token, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'claude-code-20250219' },
                body: raw,
            });
            expect(r.status).toBe(200);
            const call = fake.calls.find((c: any) => c.path === '/v1/messages');
            expect(call.headers['x-api-key']).toBe(UPSTREAM_KEY);
            expect(call.headers['anthropic-beta']).toBe('claude-code-20250219');
            expect(call.headers['anthropic-version']).toBe('2023-06-01');
            expect(call.raw).toBe(raw);
        });

        it('streams back unchanged and records the usage per request in the ledger', async () => {
            const s = await open();
            const stream = client(s.baseUrl).messages.stream({ model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'x' }] });
            const message = await stream.finalMessage();
            expect(message.usage).toMatchObject({ input_tokens: 100, output_tokens: 10 });
            await ask(s.baseUrl);
            const snap = s.close();
            expect(snap.requests.map((r) => r.status)).toEqual([200, 200]);
            expect(snap.usage).toEqual({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
        });

        it('forwards a 4xx unchanged, records it, and classifies and reports it as the AI SDK path does', async () => {
            const reports: any[] = [];
            const s = await open({ envelope: { slot: slot(), organizationId: 'org-1', provider: 'anthropic', reporter: (r) => reports.push(r) } });
            const body = { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } };
            fake.failNext({ status: 401, body });
            const err = await ask(s.baseUrl).catch((e) => e);
            expect(err.status).toBe(401);
            expect(err.error).toEqual(body);
            expect(s.ledger.lastError()).toEqual({ status: 401, body: JSON.stringify(body) });
            expect(reports).toEqual([
                expect.objectContaining({ organizationId: 'org-1', provider: 'anthropic', errorMessage: 'invalid x-api-key', category: LlmErrorCategory.AUTH_INVALID, httpStatus: 401 }),
            ]);
        });

        it('answers a non-retryable upstream error from memory for the rest of the session: one upstream call, one report', async () => {
            const reports: any[] = [];
            const s = await open({ envelope: { slot: slot(), organizationId: 'org-1', provider: 'anthropic', reporter: (r) => reports.push(r) } });
            fake.failNext({ status: 403, body: { type: 'error', error: { type: 'permission_error', message: 'no access' } } });
            for (let i = 0; i < 3; i++) expect((await ask(s.baseUrl).catch((e) => e)).status).toBe(403);
            expect(fake.calls.filter((c: any) => c.path === '/v1/messages')).toHaveLength(1);
            expect(reports).toHaveLength(1);
            // A retryable one is not remembered: the next request goes upstream.
            const s2 = await open();
            fake.failNext({ status: 529 });
            expect((await ask(s2.baseUrl).catch((e) => e)).status).toBe(529);
            expect((await ask(s2.baseUrl)).stop_reason).toBe('end_turn');
        });

        it('arms the slot cooldown from a 429 and keeps retry-after on the forwarded answer', async () => {
            const sl = slot({ cooldownMs: 60_000 } as any);
            const s = await open({ envelope: { slot: sl, organizationId: 'org-1', provider: 'anthropic' } });
            fake.failNext({ status: 429, headers: { 'retry-after': '9' } });
            const err = await ask(s.baseUrl).catch((e) => e);
            expect(err.status).toBe(429);
            expect(err.headers.get('retry-after')).toBe('9');
            expect(s.ledger.lastError()).toMatchObject({ status: 429, retryAfter: '9' });
            expect(getLimiterForSlot({ slot: sl, organizationId: 'org-1' })!.isInCooldown()).toBe(true);
        });

        it('A9: sets the caller temperature on an older Claude without thinking, never on Claude ≥4.7 or with thinking', async () => {
            const cases: Array<[string, Record<string, unknown>, number | undefined]> = [
                ['claude-sonnet-4-5', {}, 0.2],
                ['claude-3-5-haiku-20241022', {}, 0.2],
                ['claude-sonnet-4-5', { thinking: { type: 'enabled', budget_tokens: 2000 } }, undefined],
                ['claude-opus-4-7', {}, undefined],
                ['claude-sonnet-5-5', {}, undefined],
            ];
            for (const [model, extra, expected] of cases) {
                const s = await open({ temperature: 0.2 });
                const before = fake.calls.length;
                await ask(s.baseUrl, { model, ...extra });
                const sent = fake.calls.slice(before).find((c: any) => c.path === '/v1/messages').body;
                expect([model, sent.temperature]).toEqual([model, expected]);
                s.close();
            }
        });

        it('OpenRouter: bearer credential and the slot provider pin in the body', async () => {
            const s = await gateway.openSession({
                route: { format: 'anthropic', baseUrl: fake.origin, apiKey: UPSTREAM_KEY, auth: 'bearer', firstParty: false, openrouterProvider: { order: ['anthropic'], allow_fallbacks: false } },
                envelope: { slot: slot({ provider: 'open_router' } as any), organizationId: 'org-1' },
            });
            await ask(s.baseUrl, { model: 'anthropic/claude-sonnet-5.5' });
            const call = fake.calls.find((c: any) => c.path === '/v1/messages');
            expect(call.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
            expect(call.headers['x-api-key']).toBeUndefined();
            expect(call.body.provider).toEqual({ order: ['anthropic'], allow_fallbacks: false });
        });

        it('streams the upstream answer as it arrives, without buffering it', async () => {
            let release!: () => void;
            const gate = new Promise<void>((r) => (release = r));
            const first = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
            const streaming = new SdkGateway({
                fetch: (async () =>
                    new Response(
                        new ReadableStream({
                            async start(c) {
                                c.enqueue(new TextEncoder().encode(first));
                                await gate;
                                c.enqueue(new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
                                c.close();
                            },
                        }),
                        { status: 200, headers: { 'content-type': 'text/event-stream' } },
                    )) as typeof fetch,
            });
            try {
                const s = await streaming.openSession({ route: anthropicRoute(), envelope: {} });
                const r = await fetch(`${s.baseUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [] }) });
                const reader = r.body!.getReader();
                const chunk = await reader.read();
                // The first event reached the client while the upstream is still open.
                expect(new TextDecoder().decode(chunk.value)).toBe(first);
                release();
                while (!(await reader.read()).done);
            } finally {
                release();
                await streaming.close();
            }
        });

        it('answers HEAD /api/hello itself and forwards count_tokens with the credential, outside the limiter', async () => {
            const s = await open();
            expect((await fetch(`${s.baseUrl}/api/hello`, { method: 'HEAD' })).status).toBe(200);
            const count = await client(s.baseUrl).messages.countTokens({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x' }] });
            expect(count.input_tokens).toBe(100);
            expect(s.close().requests).toEqual([]);
        });
    });

    describe('per-request envelope and trace', () => {
        it('queues the second request at maxConcurrentRequests: 1', async () => {
            const sl = slot({ maxConcurrentRequests: 1 } as any);
            let release!: () => void;
            const gate = new Promise<void>((r) => (release = r));
            const order: string[] = [];
            let calls = 0;
            const slow = new SdkGateway({
                fetch: (async (url: any, init: any) => {
                    const n = calls++;
                    order.push(`start${n}`);
                    if (n === 0) await gate;
                    order.push(`end${n}`);
                    return fetch(url, init);
                }) as typeof fetch,
            });
            try {
                const s = await slow.openSession({ route: anthropicRoute(), envelope: { slot: sl, organizationId: 'org-q' } });
                const a = ask(s.baseUrl);
                for (let i = 0; i < 100 && !order.length; i++) await new Promise((r) => setTimeout(r, 10));
                const b = ask(s.baseUrl);
                await new Promise((r) => setTimeout(r, 300));
                expect(order).toEqual(['start0']);
                release();
                await Promise.all([a, b]);
                expect(order).toEqual(['start0', 'end0', 'start1', 'end1']);
            } finally {
                await slow.close();
            }
        });

        it('reconciles the tpm reservoir with the real usage of each request', async () => {
            const sl = slot({ tpm: 100_000 } as any);
            const s = await open({ envelope: { slot: sl, organizationId: 'org-t' } });
            await ask(s.baseUrl);
            const limiter: any = getLimiterForSlot({ slot: sl, organizationId: 'org-t' });
            // The fake bills 100 input + 10 output: the reservoir holds the
            // capacity minus what the request really used, not the estimate.
            // The prompt estimate is ~10 tokens, so an unreconciled reservoir would
            // sit near 99_990; refill since the call adds a few tokens at most.
            expect(limiter.reservoir).toBeGreaterThanOrEqual(100_000 - 110);
            expect(limiter.reservoir).toBeLessThan(100_000 - 110 + 30);
        });

        it('composes the Kodus platform gate for a Kodus slot', async () => {
            process.env.API_KODUS_PROVIDER_MAX_CONCURRENT = '1';
            try {
                let release!: () => void;
                const gate = new Promise<void>((r) => (release = r));
                const started: string[] = [];
                const slow = new SdkGateway({
                    fetch: (async (url: any, init: any) => {
                        started.push(String(started.length));
                        if (started.length === 1) await gate;
                        return fetch(url, init);
                    }) as typeof fetch,
                });
                try {
                    // Two orgs, no per-org cap: only the shared platform gate can hold the second.
                    const a = await slow.openSession({ route: anthropicRoute(), envelope: { slot: slot({ provider: 'kodus', model: 'anthropic/claude-sonnet-5-5' } as any), organizationId: 'org-a' } });
                    const b = await slow.openSession({ route: anthropicRoute(), envelope: { slot: slot({ provider: 'kodus', model: 'anthropic/claude-sonnet-5-5' } as any), organizationId: 'org-b' } });
                    const pa = ask(a.baseUrl);
                    for (let i = 0; i < 100 && !started.length; i++) await new Promise((r) => setTimeout(r, 10));
                    const pb = ask(b.baseUrl);
                    // Long enough for the second request to start if nothing held it.
                    await new Promise((r) => setTimeout(r, 300));
                    expect(started).toEqual(['0']);
                    release();
                    await Promise.all([pa, pb]);
                    expect(started).toEqual(['0', '1']);
                } finally {
                    await slow.close();
                }
            } finally {
                delete process.env.API_KODUS_PROVIDER_MAX_CONCURRENT;
            }
        });

        it('observes one generation per model request with model, input, output and usage, and opens no usage span', async () => {
            const spans = jest.fn();
            setLlmObservability({ runAiSdkLLMInSpan: spans as any });
            const seen: any[] = [];
            const s = await open({ observe: (o) => void seen.push(o) });
            await ask(s.baseUrl);
            await ask(s.baseUrl, { tools: [{ name: 'mcp__kodus__readFile', description: 'r', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] });
            expect(seen).toHaveLength(2);
            expect(seen[0]).toMatchObject({ model: 'claude-sonnet-5-5', status: 200, output: '{}', usage: { inputTokens: 100, outputTokens: 10 } });
            expect(seen[0].input.messages).toEqual([{ role: 'user', content: 'review a.ts' }]);
            expect(seen[1].output).toBe('mcp__kodus__readFile({"path":"fake"})');
            expect(spans).not.toHaveBeenCalled();
        });

        it('counts compaction requests by the CLI header', async () => {
            const s = await open();
            await fetch(`${s.baseUrl}/v1/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-claude-code-compaction': 'auto' },
                body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }),
            });
            expect(s.close().compactions).toBe(1);
        });

        it('keeps a limiter queue timeout as a local error and answers the CLI a non-retryable 400', async () => {
            const sl = slot({ maxConcurrentRequests: 1 } as any);
            let release!: () => void;
            const gate = new Promise<void>((r) => (release = r));
            let n = 0;
            const slow = new SdkGateway({
                fetch: (async (url: any, init: any) => {
                    if (n++ === 0) await gate;
                    return fetch(url, init);
                }) as typeof fetch,
            });
            try {
                const s = await slow.openSession({ route: anthropicRoute(), envelope: { slot: sl, organizationId: 'org-to', queueTimeoutMs: 30 } });
                const first = ask(s.baseUrl);
                const second = await ask(s.baseUrl).catch((e) => e);
                expect(second.status).toBe(400);
                expect(s.localErrors).toHaveLength(1);
                expect(s.localErrors[0].message).toMatch(/BYOK-QUEUE-TIMEOUT|queue/i);
                release();
                await first;
            } finally {
                await slow.close();
            }
        });
    });

    describe('Vertex', () => {
        const vertexRoute = (): VertexRoute => ({ format: 'vertex', project: 'p1', region: 'us-east5', credentials: { client_email: 'sa@p1' }, endpoint: fake.origin, firstParty: true });

        it('authorizes with the slot service account token on the publisher path and streams back', async () => {
            const s = await gateway.openSession({ route: vertexRoute(), envelope: { slot: slot({ provider: 'google_vertex' } as any), organizationId: 'org-v' } });
            const { createVertexAnthropic } = await import('@ai-sdk/google-vertex/anthropic');
            const vertex = createVertexAnthropic({
                project: 'p1',
                location: 'us-east5',
                baseURL: `${s.baseUrl}/v1/projects/p1/locations/us-east5/publishers/anthropic/models`,
                generateAuthToken: async () => 'not-a-real-token',
            });
            const { streamText } = await import('ai');
            const result = streamText({ model: vertex('claude-sonnet-5-5'), prompt: 'x' });
            expect(await result.text).toBe('{}');
            const call = fake.calls.find((c: any) => c.path.endsWith(':streamRawPredict'));
            expect(call.path).toBe('/v1/projects/p1/locations/us-east5/publishers/anthropic/models/claude-sonnet-5-5:streamRawPredict');
            expect(call.headers.authorization).toBe('Bearer sa-access-token');
            expect(s.close().usage).toMatchObject({ inputTokens: 100, outputTokens: 10 });
        });

        it('uses the public regional, multi-region and global hosts when no endpoint is set', async () => {
            const { vertexOrigin } = await import('./routes/vertex');
            const base = { format: 'vertex', project: 'p', credentials: 'adc', firstParty: true } as const;
            expect(vertexOrigin({ ...base, region: 'us-east5' })).toBe('https://us-east5-aiplatform.googleapis.com');
            expect(vertexOrigin({ ...base, region: 'global' })).toBe('https://aiplatform.googleapis.com');
            expect(vertexOrigin({ ...base, region: 'eu' })).toBe('https://aiplatform.eu.rep.googleapis.com');
        });
    });

    describe('Bedrock', () => {
        const codec = new EventStreamCodec(toUtf8, fromUtf8);
        const body = JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] });
        const route = (auth: BedrockRoute['auth']): BedrockRoute => ({ format: 'bedrock', region: 'us-east-1', auth, endpoint: fake.origin, firstParty: true });

        it('signs SigV4 with the slot IAM keys and passes the event stream through unchanged', async () => {
            const s = await gateway.openSession({
                route: route({ kind: 'sigv4', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'tok' }),
                envelope: { slot: slot({ provider: 'amazon_bedrock' } as any), organizationId: 'org-b' },
            });
            const r = await fetch(`${s.baseUrl}/model/us.anthropic.claude-sonnet-5-5-v1:0/invoke-with-response-stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
            expect(r.status).toBe(200);
            const bytes = Buffer.from(await r.arrayBuffer());
            const types: string[] = [];
            for (let off = 0; off < bytes.length; ) {
                const total = bytes.readUInt32BE(off);
                const msg = codec.decode(new Uint8Array(bytes.subarray(off, off + total)));
                types.push(JSON.parse(Buffer.from(JSON.parse(toUtf8(msg.body)).bytes, 'base64').toString()).type);
                off += total;
            }
            expect(types[0]).toBe('message_start');
            expect(types[types.length - 1]).toBe('message_stop');
            const call = fake.calls.find((c: any) => c.path.startsWith('/model/'));
            expect(call.path).toBe('/model/us.anthropic.claude-sonnet-5-5-v1%3A0/invoke-with-response-stream');
            expect(call.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=\S+, Signature=[0-9a-f]{64}$/);
            expect(call.headers['x-amz-security-token']).toBe('tok');
            expect(s.close().usage).toMatchObject({ inputTokens: 100, outputTokens: 10 });
        });

        it('sends a Bedrock API key as a bearer, and answers the inference-profile listing itself', async () => {
            const s = await gateway.openSession({ route: route({ kind: 'bearer', token: 'br-api-key' }), envelope: { slot: slot({ provider: 'amazon_bedrock' } as any) } });
            const r = await fetch(`${s.baseUrl}/model/us.anthropic.claude-sonnet-5-5-v1:0/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
            expect(r.status).toBe(200);
            expect(fake.calls.find((c: any) => c.path.endsWith('/invoke')).headers.authorization).toBe('Bearer br-api-key');
            const before = fake.calls.length;
            const profiles = await fetch(`${s.baseUrl}/inference-profiles?type=SYSTEM_DEFINED`);
            expect(await profiles.json()).toEqual({ inferenceProfileSummaries: [] });
            expect(fake.calls.length).toBe(before);
        });
    });
});
