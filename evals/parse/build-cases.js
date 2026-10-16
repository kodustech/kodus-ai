#!/usr/bin/env node
// Writes evals/parse/cases.json from the recorded runs (capture.js): one
// `as-sent` case per recorded PR run, and every production shape (shapes.js)
// applied to each model's run end with the most findings that the engine
// parses whole, so each shape is parsed over every model's own code and
// wording, and measures its own effect only (the model's own quirks are in its
// as-sent cases).
//
//   node evals/parse/build-cases.js
const fs = require('fs');
const path = require('path');
const { registerTs } = require('../shared/eval-kit');
const { SHAPES } = require('./shapes');

registerTs();
const { extractFindings } = require('../../libs/code-review/infrastructure/agents/core/finder.agent.ts');

const dir = path.join(__dirname, 'payloads');
const LABELS = require('./labels.json');

function asObject(end) {
    if (end.submitResult === undefined) {
        const fenced = String(end.text || '').match(/```(?:json)?\s*([\s\S]*?)```/);
        const body = fenced ? fenced[1] : String(end.text || '');
        try {
            return JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
        } catch {
            return null;
        }
    }
    if (typeof end.submitResult !== 'string') return end.submitResult;
    try {
        return JSON.parse(end.submitResult);
    } catch {
        return null;
    }
}

function listOf(end) {
    const s = asObject(end)?.suggestions;
    if (typeof s !== 'string') return s;
    try {
        return JSON.parse(s);
    } catch {
        return undefined;
    }
}

function count(end) {
    const s = listOf(end);
    return Array.isArray(s) ? s.filter((x) => x && typeof x === 'object').length : 0;
}

function main() {
    const asSent = [];
    const shaped = [];
    for (const model of fs.readdirSync(dir).sort()) {
        let best = null;
        for (const file of fs.readdirSync(path.join(dir, model)).filter((f) => f.endsWith('.json')).sort()) {
            const caseId = file.replace(/\.json$/, '');
            const payload = `payloads/${model}/${file}`;
            const { ends } = JSON.parse(fs.readFileSync(path.join(dir, model, file), 'utf8'));
            // A run end with no findings list but prose: its findings are labelled
            // by hand, and its case reaches prose recovery.
            const prose = ends.map((end, i) => ({ end, i })).filter(({ end }) => !Array.isArray(listOf(end)) && String(asObject(end)?.reasoning || end.text || '').length >= 80);
            for (const { i } of prose) if (!LABELS[`${payload}#${i}`]) console.warn(`${payload}#${i}: findings only in prose; label them in labels.json`);
            asSent.push({ id: `${model}/${caseId}`, checks: SHAPES['as-sent'].checks(model, caseId).slice(0, 160), payload, shape: 'as-sent', ...(prose.length ? { prose: true } : {}) });
            ends.forEach((end, i) => {
                const n = count(end);
                if (n < 2 || (best && n <= best.n)) return;
                const parsed = extractFindings({ artifacts: [{ type: 'submitResult', payload: { ...asObject(end), suggestions: listOf(end) } }], steps: [] });
                if (parsed.suggestions.length === n) best = { payload, end: i, n };
            });
        }
        if (!best) {
            console.warn(`${model}: no run end with two findings or more that the engine parses whole; no shapes on its output`);
            continue;
        }
        for (const [shape, { checks, prose }] of Object.entries(SHAPES)) {
            if (shape === 'as-sent') continue;
            shaped.push({ id: `${shape}/${model}`, checks: `${checks()} — on ${model}`.slice(0, 160), payload: best.payload, end: best.end, shape, ...(prose ? { prose: true } : {}) });
        }
    }
    // Prose cases first: the Friday cut (--prose --limit) takes the first few.
    const all = [...asSent, ...shaped];
    const cases = [...all.filter((c) => c.prose), ...all.filter((c) => !c.prose)];
    fs.writeFileSync(path.join(__dirname, 'cases.json'), `${JSON.stringify(cases, null, 4)}\n`);
    console.log(`wrote ${cases.length} cases (${asSent.length} as sent, ${shaped.length} shaped)`);
    return 0;
}

process.exit(main());
