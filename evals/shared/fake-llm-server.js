// Scripted OpenAI-compatible model server for the eval wiring smoke.
//
// Why a server and not a mocked LanguageModel: the engine builds its own model
// from the slot (LLM.run → buildModelFromSlot → openai_compatible executor), so
// an in-process mock would have to replace production code. Pointing the SAME
// self-hosted route at 127.0.0.1 keeps every Kodus line real — slot resolution,
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

function startFakeLlmServer({ port = 0, host = '127.0.0.1' } = {}) {
    const stats = { requests: 0, toolCalls: 0, finals: 0, byPath: {} };
    let seq = 0;
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
        });
        req.on('end', () => {
            stats.byPath[req.url] = (stats.byPath[req.url] || 0) + 1;
            if (req.method !== 'POST' || !/chat\/completions$/.test(req.url.split('?')[0])) {
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
            stats.requests += 1;
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
            resolve({
                url: `http://${host}:${address.port}/v1`,
                stats,
                close: () => new Promise((done) => server.close(() => done())),
            });
        });
    });
}

module.exports = { startFakeLlmServer, instanceOf, decide };

if (require.main === module) {
    const port = Number(process.env.PORT || 48123);
    startFakeLlmServer({ port }).then(({ url }) => {
        console.log(`fake llm listening on ${url}`);
    });
}
