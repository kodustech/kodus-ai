#!/usr/bin/env node
// Records how the finder's runs end, exactly as a model sent it, for the parse
// eval to replay. Runs the real finder (evals/investigation/agent-provider.js)
// on a real model and reads each provider response to a request that offers
// submitResult, before the engine parses it:
//   chat completions   choices[].message: tool_calls[].function.arguments, content
//   OpenAI Responses   output[]: function_call .arguments, message .content[].text
//   Anthropic Messages content[]: tool_use .input, text .text
// A response that calls submitResult, or calls no tool at all (the model
// answered in text), ends a run; both are kept, in order, with the text the
// response carried (the engine reads it when the call is unusable).
//
//   node evals/parse/capture.js --model=<tier-0 id> [--cases=<id,id>]
//
// Writes evals/parse/payloads/<model>/<caseId>.json as { ends: [{ submitResult?,
// text }] }. Spends real tokens: one full finder run per case. CAPTURE_DEBUG=1
// prints the tools each response called.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DONE_TOOL = 'submitResult';
const DEFAULT_CASES = [
    'add-guest-management-functionality-to-existing-bookings-cal-com',
    'anonymous-add-configurable-device-limit-grafana-codex',
    'span-buffer-multiprocess-enhancement-with-health-monitoring-sentry',
    'enhance-embed-url-handling-and-validation-system-discourse-cursor',
];

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);

/** The tools a request offers, by name. */
function offered(init) {
    try {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '');
        return (body?.tools ?? []).map((t) => t?.function?.name ?? t?.name);
    } catch {
        return [];
    }
}

/** One provider response, read as the model sent it: the tools it called and
 *  the text it wrote. */
function readResponse(body) {
    const calls = [];
    const texts = [];
    for (const choice of body?.choices ?? []) {
        for (const tc of choice?.message?.tool_calls ?? []) calls.push({ name: tc?.function?.name, input: tc?.function?.arguments });
        if (typeof choice?.message?.content === 'string') texts.push(choice.message.content);
    }
    for (const item of body?.output ?? []) {
        if (item?.type === 'function_call') calls.push({ name: item.name, input: item.arguments });
        if (item?.type === 'message') for (const c of item.content ?? []) if (typeof c?.text === 'string') texts.push(c.text);
    }
    for (const block of Array.isArray(body?.content) ? body.content : []) {
        if (block?.type === 'tool_use') calls.push({ name: block.name, input: block.input });
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
    return { calls, text: texts.join('') };
}

function loadCase(caseId) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/investigation/datasets', `${caseId}.json`), 'utf8'));
    return (Array.isArray(raw) ? raw[0] : raw).vars;
}

async function main() {
    const model = arg('model');
    if (!model) {
        console.error('usage: node evals/parse/capture.js --model=<tier-0 id> [--cases=<id,id>]');
        return 2;
    }
    const cases = arg('cases') ? arg('cases').split(',') : DEFAULT_CASES;
    let ends = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const res = await realFetch(input, init);
        if (!offered(init).includes(DONE_TOOL)) return res;
        try {
            const { calls, text } = readResponse(await res.clone().json());
            const done = calls.filter((c) => c.name === DONE_TOOL);
            for (const c of done) ends.push({ submitResult: c.input, text });
            if (!calls.length) ends.push({ text });
            if (process.env.CAPTURE_DEBUG) console.error(`[capture] tools=${calls.map((c) => c.name).join(',')} text=${text.length}`);
        } catch {
            /* not JSON: not a model response */
        }
        return res;
    };
    process.env.RECALL_MODEL = model;
    const Provider = require(path.join(ROOT, 'evals/investigation/agent-provider'));
    const provider = new Provider({ config: { label: `parse-capture-${model}`, provider: 'tier0', model } });
    const outDir = path.join(__dirname, 'payloads', model.replace(/[^\w.@-]+/g, '-'));
    fs.mkdirSync(outDir, { recursive: true });
    let failed = 0;
    for (const caseId of cases) {
        ends = [];
        const vars = loadCase(caseId);
        const result = await provider.callApi(JSON.stringify(vars), { vars }, {});
        if (!ends.length) {
            failed += 1;
            console.error(`${caseId}: no finder run ended${result.error ? ` (${String(result.error).slice(0, 160)})` : ''}`);
            continue;
        }
        fs.writeFileSync(
            path.join(outDir, `${caseId}.json`),
            `${JSON.stringify({ model, caseId, capturedAt: new Date().toISOString().slice(0, 10), ends }, null, 2)}\n`,
        );
        console.log(`${caseId}: recorded ${ends.length} run end(s) (${ends.map((e) => (e.submitResult === undefined ? 'text' : typeof e.submitResult)).join(', ')})`);
    }
    return failed === cases.length ? 2 : 0;
}

main().then((code) => process.exit(code)).catch((error) => {
    console.error(error);
    process.exit(2);
});
