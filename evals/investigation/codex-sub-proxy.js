#!/usr/bin/env node
// Serves OpenAI's /v1/responses on localhost from a ChatGPT subscription (the
// Codex backend), so a research run reaches GPT through the production OpenAI
// route (tier0-models.js `@sub` ids point their baseURL here) without spending
// API credit. The backend accepts only streamed, unstored calls: each request is
// sent with stream=true and store=false and the streamed response is answered
// back as one JSON body. The token is the one `codex login` saved under
// CODEX_HOME, re-read on every call.
//
// On a non-OpenAI host the route leaves `store` on (not-stored.ts), so the SDK
// points at earlier reasoning by id (item_reference), which an unstored backend
// cannot resolve. The proxy asks for the encrypted reasoning, keeps each output
// item it served, and puts the full item back where a reference names it: the
// backend then receives what production sends OpenAI with store=false.
//
//   CODEX_HOME=<account home> node evals/investigation/codex-sub-proxy.js [--port=8789]
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 8789;
const UPSTREAM = 'https://chatgpt.com/backend-api/codex/responses';
const served = new Map();
const MAX_SERVED = 50_000;
function remember(items) {
    for (const item of items || []) {
        if (!item?.id) continue;
        served.set(item.id, item);
        if (served.size > MAX_SERVED) served.delete(served.keys().next().value);
    }
}
function resolveRefs(input) {
    if (!Array.isArray(input)) return input;
    return input.map((it) => (it?.type === 'item_reference' && served.has(it.id) ? served.get(it.id) : it));
}

function auth() {
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    const t = JSON.parse(fs.readFileSync(file, 'utf8')).tokens || {};
    if (!t.access_token || !t.account_id) throw new Error(`no ChatGPT login in ${file}`);
    return t;
}

async function forward(body) {
    const t = auth();
    const { max_output_tokens, temperature, top_p, ...rest } = body;
    const res = await fetch(UPSTREAM, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${t.access_token}`,
            'chatgpt-account-id': t.account_id,
            'openai-beta': 'responses=experimental',
            originator: 'codex_cli_rs',
        },
        body: JSON.stringify({ ...rest, input: resolveRefs(rest.input), include: [...new Set([...(rest.include || []), 'reasoning.encrypted_content'])], instructions: rest.instructions || '', stream: true, store: false }),
    });
    if (!res.ok) return { status: res.status, json: { error: { message: await res.text() } } };
    const text = await res.text();
    let final = null;
    for (const block of text.split('\n\n')) {
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === 'response.completed' || ev.type === 'response.incomplete') final = ev.response;
        if (ev.type === 'response.failed') return { status: 500, json: { error: ev.response?.error || { message: 'response.failed' } } };
    }
    if (final) remember(final.output);
    return final ? { status: 200, json: final } : { status: 502, json: { error: { message: 'no completed response in stream' } } };
}

http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
        let out;
        try {
            if (req.method !== 'POST' || !req.url.endsWith('/responses')) out = { status: 404, json: { error: { message: `unsupported ${req.method} ${req.url}` } } };
            else out = await forward(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
            out = { status: 502, json: { error: { message: String(e.message || e) } } };
        }
        if (out.status !== 200) console.error(new Date().toISOString(), out.status, JSON.stringify(out.json).slice(0, 300));
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.json));
    });
}).listen(PORT, '127.0.0.1', () => console.log(`codex-sub-proxy on http://127.0.0.1:${PORT}/v1`));
