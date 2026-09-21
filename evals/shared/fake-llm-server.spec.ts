/**
 * The scripted model is what lets the wiring smoke drive the real engine with no
 * key. If it stops answering the way the engine's loop expects — explore, then
 * submit through the done tool — every eval "passes" the smoke without the
 * engine doing anything, so its script is pinned here.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startFakeLlmServer, instanceOf, decide } = require('./fake-llm-server');

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
