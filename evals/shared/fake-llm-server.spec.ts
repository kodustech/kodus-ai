/**
 * The scripted model is what lets the wiring smoke drive the real engine with no
 * key. If it stops answering the way the engine's loop expects — explore, then
 * submit through the done tool — every eval "passes" the smoke without the
 * engine doing anything, so its script is pinned here.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startFakeLlmServer, instanceOf, decide, decideAnthropic } = require('./fake-llm-server');

const readFile = {
    type: 'function',
    function: {
        name: 'readFile',
        parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 } }, required: ['path'] },
    },
};
const submitResult = {
    type: 'function',
    function: {
        name: 'submitResult',
        parameters: {
            type: 'object',
            properties: { suggestions: { type: 'array', items: { type: 'object', properties: { relevantFile: { type: 'string' } } } } },
        },
    },
};

describe('fake llm — schema instances', () => {
    it('fills every declared property, not only the required ones', () => {
        expect(instanceOf({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'] })).toEqual({ a: 'fake', b: 1 });
    });

    it('gives arrays one item so downstream stages have something to carry', () => {
        expect(instanceOf({ type: 'array', items: { type: 'string' } })).toEqual(['fake']);
        expect(instanceOf({ type: 'array', items: { type: 'string' }, maxItems: 0 })).toEqual([]);
    });

    it('answers true for booleans, so a verifier keeps the scripted finding', () => {
        expect(instanceOf({ type: 'object', properties: { keep: { type: 'boolean' } } })).toEqual({ keep: true });
    });

    it('resolves $ref, picks the non-null anyOf branch and respects enum and minLength', () => {
        const schema = {
            type: 'object',
            properties: {
                sev: { enum: ['high', 'low'] },
                maybe: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 3 }] },
                id: { type: 'string', minLength: 6 },
                item: { $ref: '#/$defs/Item' },
            },
            $defs: { Item: { type: 'object', properties: { name: { type: 'string' } } } },
        };
        expect(instanceOf(schema)).toEqual({ sev: 'high', maybe: 3, id: 'fakeee', item: { name: 'fake' } });
    });
});

describe('fake llm — the script', () => {
    const user = { role: 'user', content: 'review' };
    const toolResult = { role: 'tool', content: 'file body' };

    it('explores first when tools are offered', () => {
        expect(decide({ tools: [submitResult, readFile], messages: [user] }).tool.function.name).toBe('readFile');
    });

    it('submits through the done tool once a tool result is in the conversation', () => {
        expect(decide({ tools: [readFile, submitResult], messages: [user, toolResult] }).tool.function.name).toBe('submitResult');
    });

    it('obeys a forced tool_choice', () => {
        const body = { tools: [readFile, submitResult], messages: [user], tool_choice: { type: 'function', function: { name: 'submitResult' } } };
        expect(decide(body).tool.function.name).toBe('submitResult');
    });

    it('answers a json_schema request with an instance of that schema, and plain text otherwise', () => {
        const body = { messages: [user], response_format: { type: 'json_schema', json_schema: { schema: { type: 'object', properties: { summary: { type: 'string' } } } } } };
        expect(JSON.parse(decide(body).text)).toEqual({ summary: 'fake' });
        expect(decide({ messages: [user] }).text).toBe('{}');
    });
});

describe('fake llm — over HTTP', () => {
    let server: any;

    beforeAll(async () => {
        server = await startFakeLlmServer();
    });

    afterAll(async () => {
        await server.close();
    });

    it('speaks OpenAI chat completions, with usage, and counts what it served', async () => {
        const res = await fetch(`${server.url}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'eval-fake', tools: [readFile], messages: [{ role: 'user', content: 'x' }] }),
        });
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.choices[0].finish_reason).toBe('tool_calls');
        expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ path: 'fake', startLine: 1 });
        expect(body.usage.total_tokens).toBeGreaterThan(0);
        expect(server.stats.toolCalls).toBe(1);
    });

    it('streams the same answer as SSE when asked to', async () => {
        const res = await fetch(`${server.url}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'eval-fake', stream: true, messages: [{ role: 'user', content: 'x' }] }),
        });
        const text = await res.text();

        expect(res.headers.get('content-type')).toContain('text/event-stream');
        expect(text).toContain('"content":"{}"');
        expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    });

    it('rejects anything that is not a chat completion, so a wrong route fails loudly', async () => {
        const res = await fetch(`${server.url}/responses`, { method: 'POST', body: '{}' });
        expect(res.status).toBe(404);
    });
});

// #2113: the Claude Agent SDK's CLI talks Anthropic Messages in three envelopes.
// Each mode is read here by a client we did not write (Anthropic's SDK, the AI
// SDK's Vertex provider, AWS's event-stream codec), so the fake cannot drift
// into a dialect only our gateway understands.
describe('fake llm — Anthropic Messages, Vertex, Bedrock', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Anthropic = require('@anthropic-ai/sdk').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EventStreamCodec } = require('@smithy/eventstream-codec');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { fromUtf8, toUtf8 } = require('@smithy/util-utf8');

    const readTool = { name: 'mcp__kodus__readFile', description: 'read', input_schema: readFile.function.parameters };
    const submitTool = { name: 'mcp__kodus__submitResult', description: 'submit', input_schema: submitResult.function.parameters };
    const KEY = 'session-token-1';
    let server: any;
    let client: any;

    beforeEach(async () => {
        server = await startFakeLlmServer({ auth: { anthropicKey: KEY, vertexToken: 'sa-token', bedrockToken: 'br-token' } });
        client = new Anthropic({ apiKey: KEY, baseURL: server.origin, maxRetries: 0 });
    });

    afterEach(async () => {
        await server.close();
    });

    it('scripts explore → submit → end of turn from the Anthropic body, MCP-prefixed names included', () => {
        const first = decideAnthropic({ tools: [submitTool, readTool], messages: [{ role: 'user', content: 'review' }] });
        expect(first.tool.name).toBe('mcp__kodus__readFile');
        const second = decideAnthropic({
            tools: [submitTool, readTool],
            messages: [
                { role: 'user', content: 'review' },
                { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'mcp__kodus__readFile', input: {} }] },
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'body' }] },
            ],
        });
        expect(second.tool.name).toBe('mcp__kodus__submitResult');
        const third = decideAnthropic({
            tools: [submitTool, readTool],
            messages: [
                { role: 'user', content: 'review' },
                { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'mcp__kodus__submitResult', input: {} }] },
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'submitted' }] },
            ],
        });
        expect(third).toEqual({ text: '{}' });
        expect(decideAnthropic({ tools: [readTool, submitTool], messages: [], tool_choice: { type: 'tool', name: 'mcp__kodus__submitResult' } }).tool.name).toBe(
            'mcp__kodus__submitResult',
        );
        expect(JSON.parse(decideAnthropic({ messages: [], output_config: { format: { type: 'json_schema', schema: submitResult.function.parameters } } }).text)).toEqual({
            suggestions: [{ relevantFile: 'fake' }],
        });
    });

    it('streams a tool_use turn that Anthropic’s own SDK assembles, with usage in message_start and message_delta', async () => {
        const stream = client.messages.stream({ model: 'claude-sonnet-5-5', max_tokens: 100, tools: [readTool], messages: [{ role: 'user', content: 'x' }] });
        const events: string[] = [];
        stream.on('streamEvent', (e: any) => events.push(e.type));
        const message = await stream.finalMessage();

        expect(message.stop_reason).toBe('tool_use');
        expect(message.content).toEqual([{ type: 'tool_use', id: expect.stringMatching(/^toolu_fake_/), name: 'mcp__kodus__readFile', input: { path: 'fake', startLine: 1 } }]);
        expect(message.usage).toMatchObject({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
        expect(events[0]).toBe('message_start');
        expect(events).toContain('message_delta');
        expect(events[events.length - 1]).toBe('message_stop');
        expect(server.stats.byModel['claude-sonnet-5-5']).toBe(1);
    });

    it('answers non-streaming Messages and a structured-output request with a schema instance', async () => {
        const message = await client.messages.create({
            model: 'claude-sonnet-5-5',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'x' }],
            output_config: { format: { type: 'json_schema', schema: submitResult.function.parameters } },
        } as any);
        expect(message.stop_reason).toBe('end_turn');
        expect(JSON.parse(message.content[0].text)).toEqual({ suggestions: [{ relevantFile: 'fake' }] });
    });

    it('records every request with its headers and body, so a test can read what the CLI sent', async () => {
        await client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'note-123' }] });
        const call = server.calls.find((c: any) => c.path === '/v1/messages');
        expect(call.headers['x-api-key']).toBe(KEY);
        expect(call.headers['anthropic-version']).toBe('2023-06-01');
        expect(call.body.messages[0].content).toBe('note-123');
    });

    it('rejects a wrong key with 401 authentication_error', async () => {
        const wrong = new Anthropic({ apiKey: 'not-the-session', baseURL: server.origin, maxRetries: 0 });
        await expect(wrong.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
            status: 401,
            error: { type: 'error', error: { type: 'authentication_error' } },
        });
        expect(server.stats.requests).toBe(0);
    });

    it('serves a scripted 429 with retry-after once, then answers normally', async () => {
        server.failNext({ status: 429, headers: { 'retry-after': '7' } });
        const req = () => client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] });
        const err: any = await req().catch((e: any) => e);
        expect(err.status).toBe(429);
        expect(err.headers.get('retry-after')).toBe('7');
        expect(err.error.error.type).toBe('rate_limit_error');
        expect((await req()).stop_reason).toBe('end_turn');
    });

    it('answers count_tokens and HEAD /api/hello, and 404s an unknown Anthropic path', async () => {
        const count = await client.messages.countTokens({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x' }] });
        expect(count.input_tokens).toBe(100);
        expect((await fetch(`${server.origin}/api/hello`, { method: 'HEAD' })).status).toBe(200);
        expect((await fetch(`${server.origin}/v1/complete`, { method: 'POST', body: '{}' })).status).toBe(404);
    });

    describe('Vertex rawPredict', () => {
        const vertexModel = (token: string) => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { createVertexAnthropic } = require('@ai-sdk/google-vertex/anthropic');
            const vertex = createVertexAnthropic({
                project: 'p1',
                location: 'us-east5',
                baseURL: `${server.origin}/v1/projects/p1/locations/us-east5/publishers/anthropic/models`,
                generateAuthToken: async () => token,
            });
            return vertex('claude-sonnet-5-5');
        };

        it('streams through :streamRawPredict with the bearer and anthropic_version the vertex client sends, usage included', async () => {
            const { streamText } = require('ai');
            const result = streamText({ model: vertexModel('sa-token'), prompt: 'x' });
            const text = await result.text;
            const usage = await result.usage;

            expect(text).toBe('{}');
            expect(usage.inputTokens).toBe(100);
            expect(usage.outputTokens).toBe(10);
            const call = server.calls.find((c: any) => c.path.endsWith(':streamRawPredict'));
            expect(call.path).toBe('/v1/projects/p1/locations/us-east5/publishers/anthropic/models/claude-sonnet-5-5:streamRawPredict');
            expect(call.body.anthropic_version).toBe('vertex-2023-10-16');
            expect(server.stats.byModel['claude-sonnet-5-5']).toBe(1);
        });

        it('rejects a wrong bearer with 401 and a body without anthropic_version with 400', async () => {
            const path = '/v1/projects/p1/locations/us-east5/publishers/anthropic/models/claude-sonnet-5-5:rawPredict';
            const post = (headers: Record<string, string>, body: object) =>
                fetch(`${server.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
            const good = { anthropic_version: 'vertex-2023-10-16', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] };

            expect((await post({ authorization: 'Bearer other' }, good)).status).toBe(401);
            expect((await post({}, good)).status).toBe(401);
            expect((await post({ authorization: 'Bearer sa-token' }, { ...good, anthropic_version: undefined })).status).toBe(400);
            const ok = await post({ authorization: 'Bearer sa-token' }, good);
            expect(ok.status).toBe(200);
            expect((await ok.json()).usage.input_tokens).toBe(100);
        });
    });

    describe('Bedrock InvokeModel', () => {
        const codec = new EventStreamCodec(toUtf8, fromUtf8);
        const path = '/model/us.anthropic.claude-sonnet-5-5-v1%3A0/invoke-with-response-stream';
        const body = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] };
        const sigv4 = 'AWS4-HMAC-SHA256 Credential=AKIAFAKE/20261020/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=0123abcd';
        const post = (p: string, authorization: string | undefined, b: object = body) =>
            fetch(`${server.origin}${p}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
                body: JSON.stringify(b),
            });

        // Splits the response into frames by the prelude's total length and decodes each with AWS's codec.
        const decodeFrames = (buf: Buffer) => {
            const frames: any[] = [];
            let offset = 0;
            while (offset < buf.length) {
                const total = buf.readUInt32BE(offset);
                const msg = codec.decode(new Uint8Array(buf.subarray(offset, offset + total)));
                frames.push({ headers: msg.headers, event: JSON.parse(Buffer.from(JSON.parse(toUtf8(msg.body)).bytes, 'base64').toString('utf8')) });
                offset += total;
            }
            return frames;
        };

        it('frames each Messages event as an AWS event-stream chunk that AWS’s codec decodes (CRCs checked), usage included', async () => {
            const res = await post(path, sigv4);
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toBe('application/vnd.amazon.eventstream');
            const frames = decodeFrames(Buffer.from(await res.arrayBuffer()));

            expect(frames.every((f) => f.headers[':event-type'].value === 'chunk' && f.headers[':message-type'].value === 'event')).toBe(true);
            expect(frames.map((f) => f.event.type)).toEqual([
                'message_start',
                'content_block_start',
                'content_block_delta',
                'content_block_stop',
                'message_delta',
                'message_stop',
            ]);
            expect(frames[0].event.message.usage.input_tokens).toBe(100);
            expect(frames[4].event.usage.output_tokens).toBe(10);
            expect(frames[5].event['amazon-bedrock-invocationMetrics']).toMatchObject({ inputTokenCount: 100, outputTokenCount: 10 });
            expect(server.stats.byModel['us.anthropic.claude-sonnet-5-5-v1:0']).toBe(1);
        });

        it('accepts a bearer API key, rejects a request with neither signature nor bearer, and checks anthropic_version', async () => {
            expect((await post(path, 'Bearer br-token')).status).toBe(200);
            expect((await post(path, 'Bearer other')).status).toBe(401);
            expect((await post(path, undefined)).status).toBe(401);
            expect((await post(path, sigv4, { ...body, anthropic_version: 'vertex-2023-10-16' })).status).toBe(400);
        });

        it('answers /invoke as JSON and lists no inference profiles', async () => {
            const res = await post('/model/us.anthropic.claude-sonnet-5-5-v1%3A0/invoke', sigv4);
            expect(res.headers.get('content-type')).toContain('application/json');
            expect((await res.json()).content).toEqual([{ type: 'text', text: '{}' }]);
            const profiles = await fetch(`${server.origin}/inference-profiles?type=SYSTEM_DEFINED`);
            expect(await profiles.json()).toEqual({ inferenceProfileSummaries: [] });
        });
    });
});
