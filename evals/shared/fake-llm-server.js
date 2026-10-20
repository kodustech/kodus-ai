// Scripted model server for the eval wiring smoke: OpenAI-compatible, plus the
// Anthropic Messages, Vertex and Bedrock envelopes the Claude Agent SDK uses.
//
// Why a server and not a mocked LanguageModel: the engine builds its own model
// from the slot (LLM.run → buildModelFromSlot → openai_compatible executor), so
// an in-process mock would have to replace production code. Pointing an org's
// BYOK route at 127.0.0.1 keeps every Kodus line real — slot resolution,
// provider options, tool registry, structured-output parsing — and swaps only
// the vendor at the network edge. No key, no cost, deterministic.
//
// Script (per request, stateless — the conversation carries the state):
//   1. forced tool_choice        → call that tool
//   2. tools offered, no tool result yet in the conversation
//                                → call one exploration tool (read > grep > first)
//   3. a done tool is offered (submitResult, submitVerdict, …)
//                                → call it with a schema instance, so the
//                                  engine gets ONE finding/verdict to carry
//                                  through verify, dedup and scoring
//   4. otherwise                 → final answer: a schema instance of the
//                                  requested json_schema, or "{}" as text
//
// It does not try to review anything. It proves the harness can drive the real
// engine end-to-end; quality is the nightly's job.
const http = require('http');

const EXPLORATION_PREFERENCE = [/read/i, /grep|search/i, /list|find/i];
const DONE_TOOL = /^(submit|done|final|finish|report)/i;

function resolveRef(ref, root) {
    const parts = String(ref).replace(/^#\//, '').split('/');
    let node = root;
    for (const part of parts) node = node?.[part];
    return node || {};
}

// A value that satisfies the common JSON-schema shapes the engine sends. Every
// declared property is filled and arrays get one item (not zero), so the output
// carries something for the downstream stages to process.
function instanceOf(schema, root = schema, depth = 0) {
    if (!schema || typeof schema !== 'object' || depth > 12) return null;
    if (schema.$ref) return instanceOf(resolveRef(schema.$ref, root), root, depth + 1);
    if ('const' in schema) return schema.const;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    for (const key of ['anyOf', 'oneOf']) {
        if (Array.isArray(schema[key]) && schema[key].length) {
            const nonNull = schema[key].find((s) => s?.type !== 'null') || schema[key][0];
            return instanceOf(nonNull, root, depth + 1);
        }
    }
    if (Array.isArray(schema.allOf) && schema.allOf.length) {
        return Object.assign({}, ...schema.allOf.map((s) => instanceOf(s, root, depth + 1) || {}));
    }
    const type = Array.isArray(schema.type)
        ? schema.type.find((t) => t !== 'null') || schema.type[0]
        : schema.type || (schema.properties ? 'object' : undefined);
    switch (type) {
        case 'object': {
            const out = {};
            const props = schema.properties || {};
            for (const name of Object.keys(props)) {
                out[name] = instanceOf(props[name] || {}, root, depth + 1);
            }
            return out;
        }
        case 'array': {
            const max = typeof schema.maxItems === 'number' ? schema.maxItems : Infinity;
            const length = Math.min(Math.max(Number(schema.minItems || 0), 1), max);
            return Array.from({ length }, () => instanceOf(schema.items || {}, root, depth + 1));
        }
        case 'string':
            return 'fake'.padEnd(Number(schema.minLength || 0), 'e');
        case 'integer':
        case 'number':
            return typeof schema.minimum === 'number' ? schema.minimum : 1;
        case 'boolean':
            // true, so a verifier's `keep` lets the one finding reach scoring.
            return true;
        case 'null':
            return null;
        default:
            return null;
    }
}

function pickExplorationTool(tools) {
    for (const pattern of EXPLORATION_PREFERENCE) {
        const hit = tools.find((t) => pattern.test(t.function?.name || ''));
        if (hit) return hit;
    }
    return tools[0];
}

function pickTool(tools, name) {
    return tools.find((t) => t.function.name === name);
}

function decide(body) {
    const tools = Array.isArray(body.tools) ? body.tools.filter((t) => t?.function?.name) : [];
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const toolResults = messages.filter((m) => m.role === 'tool').length;
    const choice = body.tool_choice;

    if (tools.length && choice && typeof choice === 'object' && choice.function?.name) {
        return { tool: pickTool(tools, choice.function.name) || tools[0] };
    }
    if (tools.length && choice !== 'none') {
        const done = tools.find((t) => DONE_TOOL.test(t.function.name));
        const exploration = tools.filter((t) => t !== done);
        if (toolResults === 0 && exploration.length) return { tool: pickExplorationTool(exploration) };
        if (done) return { tool: done };
        if (choice === 'required') return { tool: pickExplorationTool(tools) };
    }

    const format = body.response_format;
    if (format?.type === 'json_schema' && format.json_schema?.schema) {
        return { text: JSON.stringify(instanceOf(format.json_schema.schema)) };
    }
    return { text: '{}' };
}

function completionFor(body, decision, seq) {
    const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
    const message = { role: 'assistant', content: decision.text ?? null };
    let finishReason = 'stop';
    if (decision.tool) {
        const params = decision.tool.function.parameters || {};
        message.tool_calls = [
            {
                id: `call_fake_${seq}`,
                type: 'function',
                function: {
                    name: decision.tool.function.name,
                    arguments: JSON.stringify(instanceOf(params) || {}),
                },
            },
        ];
        finishReason = 'tool_calls';
    }
    return {
        id: `chatcmpl-fake-${seq}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model || 'eval-fake',
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage,
    };
}

function writeStream(res, completion) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const choice = completion.choices[0];
    const base = { id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model };
    const delta = { role: 'assistant' };
    if (choice.message.content !== null) delta.content = choice.message.content;
    if (choice.message.tool_calls) {
        delta.tool_calls = choice.message.tool_calls.map((call, index) => ({ index, ...call }));
    }
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: completion.usage })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
}

// ─── Anthropic Messages, Vertex rawPredict and Bedrock InvokeModel (#2113) ───
//
// The Claude Agent SDK's CLI speaks Anthropic Messages to whatever base URL it
// is given, in one of three envelopes: first-party (`/v1/messages`), Vertex
// (`:rawPredict` / `:streamRawPredict` on the publisher model path) and Bedrock
// (`/model/{id}/invoke[-with-response-stream]`, AWS event stream). The script
// is the same one as above, read from the Anthropic body shape.
//
// Test hooks, all optional:
//   failNext({ status, body, headers }) → the next model request gets that error
//   calls                               → every request, with headers and body
//   anthropicScript(body, seq)          → replaces the script for one test

const ANTHROPIC_DONE_TOOL = /^(submit|done|final|finish|report|structuredoutput)/i;

// MCP tools reach the model as `mcp__<server>__<name>`; the script reads the name.
function bareToolName(name) {
    return String(name || '').replace(/^mcp__.+?__/, '');
}

// The CLI owns the loop and ends it only when a turn has no tool call, so once
// the done tool's result is back the script answers text and the query ends.
function anthropicDoneToolCalled(messages) {
    return messages.some(
        (m) => m?.role === 'assistant' && Array.isArray(m.content) && m.content.some((c) => c?.type === 'tool_use' && ANTHROPIC_DONE_TOOL.test(bareToolName(c.name))),
    );
}

function anthropicToolResults(messages) {
    let count = 0;
    for (const m of messages) {
        if (m?.role !== 'user' || !Array.isArray(m.content)) continue;
        count += m.content.filter((c) => c?.type === 'tool_result').length;
    }
    return count;
}

function anthropicJsonSchema(body) {
    return body.output_config?.format?.schema || body.output_format?.schema || null;
}

function decideAnthropic(body) {
    const tools = Array.isArray(body.tools) ? body.tools.filter((t) => t?.name && t.input_schema) : [];
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const choice = body.tool_choice;

    if (tools.length && choice?.type === 'tool' && choice.name) {
        return { tool: tools.find((t) => t.name === choice.name) || tools[0] };
    }
    if (tools.length && choice?.type !== 'none' && !anthropicDoneToolCalled(messages)) {
        const done = tools.find((t) => ANTHROPIC_DONE_TOOL.test(bareToolName(t.name)));
        const exploration = tools.filter((t) => t !== done);
        if (anthropicToolResults(messages) === 0 && exploration.length) {
            for (const pattern of EXPLORATION_PREFERENCE) {
                const hit = exploration.find((t) => pattern.test(bareToolName(t.name)));
                if (hit) return { tool: hit };
            }
            return { tool: exploration[0] };
        }
        if (done) return { tool: done };
        if (choice?.type === 'any') return { tool: exploration[0] };
    }
    const schema = anthropicJsonSchema(body);
    if (schema) return { text: JSON.stringify(instanceOf(schema)) };
    return { text: '{}' };
}

const ANTHROPIC_USAGE = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function anthropicMessageFor(body, decision, seq) {
    const content = [];
    if (decision.text !== undefined) content.push({ type: 'text', text: decision.text });
    if (decision.tool) {
        content.push({ type: 'tool_use', id: `toolu_fake_${seq}`, name: decision.tool.name, input: instanceOf(decision.tool.input_schema) || {} });
    }
    return {
        id: `msg_fake_${seq}`,
        type: 'message',
        role: 'assistant',
        model: body.model || 'eval-fake',
        content,
        stop_reason: decision.tool ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { ...ANTHROPIC_USAGE, ...(decision.usage || {}) },
    };
}

/** The Messages stream as event objects, in the order the API sends them. */
function anthropicStreamEvents(message) {
    const events = [
        {
            type: 'message_start',
            message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } },
        },
    ];
    message.content.forEach((block, index) => {
        if (block.type === 'text') {
            events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
            events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
        } else {
            events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
            events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        }
        events.push({ type: 'content_block_stop', index });
    });
    events.push({
        type: 'message_delta',
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: message.usage.output_tokens },
    });
    events.push({ type: 'message_stop' });
    return events;
}

function writeAnthropicSse(res, message) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const event of anthropicStreamEvents(message)) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
}

// AWS event stream frame: prelude (total length, headers length, CRC), string
// headers, payload, message CRC. Bedrock wraps each Messages event as
// `{"bytes": base64(event JSON)}` in a `chunk` event.
function eventStreamFrame(headers, payload) {
    const { crc32 } = require('zlib');
    const headerBufs = Object.entries(headers).map(([name, value]) => {
        const n = Buffer.from(name, 'utf8');
        const v = Buffer.from(value, 'utf8');
        const out = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
        out.writeUInt8(n.length, 0);
        n.copy(out, 1);
        out.writeUInt8(7, 1 + n.length);
        out.writeUInt16BE(v.length, 2 + n.length);
        v.copy(out, 4 + n.length);
        return out;
    });
    const headerBytes = Buffer.concat(headerBufs);
    const body = Buffer.from(payload, 'utf8');
    const total = 12 + headerBytes.length + body.length + 4;
    const prelude = Buffer.alloc(8);
    prelude.writeUInt32BE(total, 0);
    prelude.writeUInt32BE(headerBytes.length, 4);
    const preludeCrc = Buffer.alloc(4);
    preludeCrc.writeUInt32BE(crc32(prelude) >>> 0, 0);
    const withoutCrc = Buffer.concat([prelude, preludeCrc, headerBytes, body]);
    const messageCrc = Buffer.alloc(4);
    messageCrc.writeUInt32BE(crc32(withoutCrc) >>> 0, 0);
    return Buffer.concat([withoutCrc, messageCrc]);
}

function writeBedrockEventStream(res, message) {
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
    const events = anthropicStreamEvents(message);
    const last = events[events.length - 1];
    last['amazon-bedrock-invocationMetrics'] = {
        inputTokenCount: message.usage.input_tokens,
        outputTokenCount: message.usage.output_tokens,
        invocationLatency: 1,
        firstByteLatency: 1,
    };
    for (const event of events) {
        const payload = JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString('base64') });
        res.write(eventStreamFrame({ ':event-type': 'chunk', ':content-type': 'application/json', ':message-type': 'event' }, payload));
    }
    res.end();
}

const ANTHROPIC_ERROR_TYPE = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    402: 'billing_error',
    403: 'permission_error',
    404: 'not_found_error',
    429: 'rate_limit_error',
    500: 'api_error',
    529: 'overloaded_error',
};

function anthropicErrorBody(status, message) {
    return { type: 'error', error: { type: ANTHROPIC_ERROR_TYPE[status] || 'api_error', message: message || `fake llm: scripted ${status}` } };
}

/**
 * Which envelope a request is in, or null for a path no Claude route uses.
 * `stream` is what the path or the body asks for.
 */
function routeAnthropicRequest(method, pathname) {
    if (method === 'HEAD' && pathname === '/api/hello') return { kind: 'hello' };
    if (method === 'GET' && /^\/inference-profiles/.test(pathname)) return { kind: 'bedrock-profiles' };
    if (method !== 'POST') return null;
    if (/\/v1\/messages\/count_tokens$/.test(pathname)) return { kind: 'count-tokens' };
    if (/\/v1\/messages$/.test(pathname)) return { kind: 'messages', format: 'anthropic' };
    const vertex = pathname.match(/^\/v1\/projects\/[^/]+\/locations\/[^/]+\/publishers\/anthropic\/models\/([^/:]+):(rawPredict|streamRawPredict)$/);
    if (vertex) return { kind: 'messages', format: 'vertex', model: decodeURIComponent(vertex[1]), stream: vertex[2] === 'streamRawPredict' };
    const bedrock = pathname.match(/^\/model\/([^/]+)\/(invoke|invoke-with-response-stream)$/);
    if (bedrock) return { kind: 'messages', format: 'bedrock', model: decodeURIComponent(bedrock[1]), stream: bedrock[2] === 'invoke-with-response-stream' };
    return null;
}

/** Credential the envelope requires; a missing one answers 401 like the vendor. */
function authRejection(route, headers, auth) {
    if (route.format === 'anthropic' && auth.anthropicKey !== undefined) {
        const bearer = String(headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (headers['x-api-key'] !== auth.anthropicKey && bearer !== auth.anthropicKey) return 'x-api-key does not match';
    }
    if (route.format === 'vertex') {
        const expected = auth.vertexToken;
        const got = String(headers.authorization || '');
        if (!/^Bearer\s+\S+/i.test(got)) return 'missing bearer token';
        if (expected !== undefined && got !== `Bearer ${expected}`) return 'bearer token does not match';
    }
    if (route.format === 'bedrock') {
        const got = String(headers.authorization || '');
        const sigv4 = /^AWS4-HMAC-SHA256 Credential=\S+, SignedHeaders=\S+, Signature=[0-9a-f]+$/.test(got);
        const bearer = /^Bearer\s+\S+/i.test(got);
        if (!sigv4 && !bearer) return 'missing SigV4 signature or bearer token';
        if (bearer && auth.bedrockToken !== undefined && got !== `Bearer ${auth.bedrockToken}`) return 'bearer token does not match';
    }
    return null;
}

/** Body field each envelope requires, per the vendor docs. */
function bodyRejection(route, body) {
    if (route.format === 'anthropic' && !body.model) return 'model is required';
    if (route.format === 'vertex') {
        if (body.anthropic_version !== 'vertex-2023-10-16') return 'anthropic_version must be vertex-2023-10-16';
    }
    if (route.format === 'bedrock') {
        if (body.anthropic_version !== 'bedrock-2023-05-31') return 'anthropic_version must be bedrock-2023-05-31';
    }
    if (!Array.isArray(body.messages)) return 'messages is required';
    return null;
}

function startFakeLlmServer({ port = 0, host = '127.0.0.1', auth = {}, anthropicScript } = {}) {
    // byModel: requests per model id asked for, so a step can prove which model its route reached.
    const stats = { requests: 0, toolCalls: 0, finals: 0, byPath: {}, byModel: {} };
    const calls = [];
    const pendingErrors = [];
    let seq = 0;

    const sendJson = (res, status, payload, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
    };

    const serveAnthropic = (req, res, route, raw) => {
        if (route.kind === 'hello') {
            res.writeHead(200);
            res.end();
            return;
        }
        if (route.kind === 'bedrock-profiles') {
            sendJson(res, 200, { inferenceProfileSummaries: [] });
            return;
        }
        let body;
        try {
            body = JSON.parse(raw || '{}');
        } catch {
            sendJson(res, 400, anthropicErrorBody(400, 'fake llm: body is not JSON'));
            return;
        }
        calls[calls.length - 1].body = body;
        const authError = authRejection(route, req.headers, auth);
        if (authError) {
            sendJson(res, 401, anthropicErrorBody(401, `fake llm: ${authError}`));
            return;
        }
        if (route.kind === 'count-tokens') {
            sendJson(res, 200, { input_tokens: ANTHROPIC_USAGE.input_tokens });
            return;
        }
        const bodyError = bodyRejection(route, body);
        if (bodyError) {
            sendJson(res, 400, anthropicErrorBody(400, `fake llm: ${bodyError}`));
            return;
        }
        const model = route.model || body.model || '';
        stats.requests += 1;
        stats.byModel[model] = (stats.byModel[model] || 0) + 1;
        const scripted = pendingErrors.shift();
        if (scripted) {
            const errorBody = scripted.body ?? anthropicErrorBody(scripted.status);
            sendJson(res, scripted.status, errorBody, scripted.headers || {});
            return;
        }
        seq += 1;
        const decision = (anthropicScript && anthropicScript(body, seq)) || decideAnthropic(body);
        if (decision.tool) stats.toolCalls += 1;
        else stats.finals += 1;
        const message = anthropicMessageFor({ ...body, model }, decision, seq);
        const stream = route.stream ?? !!body.stream;
        if (!stream) {
            sendJson(res, 200, message);
            return;
        }
        if (route.format === 'bedrock') writeBedrockEventStream(res, message);
        else writeAnthropicSse(res, message);
    };

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
        });
        req.on('end', () => {
            stats.byPath[req.url] = (stats.byPath[req.url] || 0) + 1;
            const pathname = req.url.split('?')[0];
            calls.push({ method: req.method, path: pathname, headers: req.headers, raw });
            const anthropicRoute = routeAnthropicRequest(req.method, pathname);
            if (anthropicRoute) {
                serveAnthropic(req, res, anthropicRoute, raw);
                return;
            }
            if (req.method !== 'POST' || !/chat\/completions$/.test(pathname)) {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `fake llm: unsupported ${req.method} ${req.url}` } }));
                return;
            }
            let body;
            try {
                body = JSON.parse(raw || '{}');
            } catch {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'fake llm: body is not JSON' } }));
                return;
            }
            calls[calls.length - 1].body = body;
            stats.requests += 1;
            stats.byModel[body.model || ''] = (stats.byModel[body.model || ''] || 0) + 1;
            seq += 1;
            const decision = decide(body);
            if (decision.tool) stats.toolCalls += 1;
            else stats.finals += 1;
            const completion = completionFor(body, decision, seq);
            if (body.stream) {
                writeStream(res, completion);
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(completion));
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            const address = server.address();
            const origin = `http://${host}:${address.port}`;
            resolve({
                url: `${origin}/v1`,
                origin,
                stats,
                calls,
                failNext: (error) => {
                    pendingErrors.push(error);
                },
                close: () => new Promise((done) => server.close(() => done())),
            });
        });
    });
}

module.exports = { startFakeLlmServer, instanceOf, decide, decideAnthropic, anthropicStreamEvents };

if (require.main === module) {
    const port = Number(process.env.PORT || 48123);
    startFakeLlmServer({ port }).then(({ url }) => {
        console.log(`fake llm listening on ${url}`);
    });
}
