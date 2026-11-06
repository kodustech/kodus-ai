#!/usr/bin/env node
// GPT through the ChatGPT subscription (Codex login), for the benchmark runs.
//
// Production reaches GPT on the native OpenAI provider (/v1/responses). This
// proxy stands where api.openai.com would: the eval's BYOK slot points the
// native provider's baseURL here (tier0-models.js `@sub` ids), so the review
// runs production's code end to end and only the transport differs. Nothing in
// libs/ knows about it (the in-libs route was removed in 88453e8c0).
//
// The Codex backend (chatgpt.com/backend-api/codex/responses) differs from the
// API in three ways this bridges:
//   - it authenticates with the Codex OAuth token (~/.codex/auth.json, re-read
//     on every request so a token the Codex app refreshed is picked up);
//   - it only streams: a non-streaming request is sent with stream:true and the
//     SSE is folded back into the JSON body /v1/responses returns;
//   - its `response.completed` may carry an empty `output`: the items are
//     rebuilt from the `response.output_item.done` events.
//
// A subscription account answers "overloaded" to a burst of parallel calls,
// so calls past MAX_IN_FLIGHT wait here. Run it once for every GPT run:
//   node evals/shared/codex-subscription-proxy.js
const http = require('http');
const fs = require('fs');
const os = require('os');

const PORT = 18765;
const MAX_IN_FLIGHT = 6;
const UPSTREAM = 'https://chatgpt.com/backend-api/codex/responses';

function readAuth() {
    const file = `${process.env.CODEX_HOME || `${os.homedir()}/.codex`}/auth.json`;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const token = raw?.tokens?.access_token;
    const accountId = raw?.tokens?.account_id;
    if (!token || !accountId) throw new Error(`no Codex login in ${file}: run \`codex login\``);
    return { token, accountId };
}

let inFlight = 0;
const waiting = [];
async function acquire() {
    if (inFlight >= MAX_IN_FLIGHT) await new Promise((ok) => waiting.push(ok));
    inFlight += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        inFlight -= 1;
        waiting.shift()?.();
    };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

// The SSE of one response, folded into the body a non-streaming call returns.
async function foldStream(body) {
    const decoder = new TextDecoder();
    const items = new Map();
    let buffer = '';
    let final = null;
    let failure = null;
    const onEvent = (data) => {
        if (!data || data === '[DONE]') return;
        let event;
        try {
            event = JSON.parse(data);
        } catch {
            return;
        }
        if (event.type === 'response.output_item.done') items.set(event.output_index, event.item);
        else if (event.type === 'response.completed' || event.type === 'response.incomplete') final = event.response;
        else if (event.type === 'response.failed') failure = event.response?.error || event;
        else if (event.type === 'error') failure = event.error || event;
    };
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            onEvent(block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'));
        }
    }
    if (buffer.trim()) onEvent(buffer.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'));
    if (failure) return { status: 502, json: { error: failure } };
    if (!final) return { status: 502, json: { error: { message: 'Codex stream ended without a response' } } };
    if (!final.output?.length && items.size) final.output = [...items.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
    return { status: 200, json: final };
}

async function handle(req, res) {
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `not proxied: ${req.method} ${req.url}` } }));
        return;
    }
    const request = JSON.parse(await readBody(req));
    const wantsStream = request.stream === true;
    const release = await acquire();
    try {
        const { token, accountId } = readAuth();
        const upstream = await fetch(UPSTREAM, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'chatgpt-account-id': accountId,
                'OpenAI-Beta': 'responses=experimental',
                originator: 'codex_cli_rs',
                'content-type': 'application/json',
                accept: 'text/event-stream',
            },
            body: JSON.stringify({ ...request, stream: true, store: false }),
        });
        if (!upstream.ok) {
            res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
            res.end(await upstream.text());
            return;
        }
        if (wantsStream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            for await (const chunk of upstream.body) res.write(chunk);
            res.end();
            return;
        }
        const { status, json } = await foldStream(upstream.body);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
    } finally {
        release();
    }
}

const BASE_URL = `http://127.0.0.1:${PORT}/v1`;

if (require.main === module) {
    readAuth();
    http.createServer((req, res) => {
        handle(req, res).catch((error) => {
            if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: String(error?.message || error) } }));
        });
    }).listen(PORT, '127.0.0.1', () => console.log(`Codex subscription proxy on ${BASE_URL} (at most ${MAX_IN_FLIGHT} calls at once)`));
}

module.exports = { BASE_URL, foldStream };
