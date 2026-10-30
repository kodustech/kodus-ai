#!/usr/bin/env node
// Writes evals/format/batches.json and cases.json. A batch is what the stage
// hands the formatter in one call: the findings of one review. Each comes from
// a finder run recorded for the parse eval (evals/parse/payloads), the run end
// with the most findings per model and PR, as the model wrote them. A case is
// a batch under one production configuration (variants.js).
//
//   node evals/format/build-cases.js
const fs = require('fs');
const path = require('path');
const { VARIANTS } = require('./variants');

const PAYLOADS = path.join(__dirname, '..', 'parse', 'payloads');

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

function findings(end) {
    let s = asObject(end)?.suggestions;
    if (typeof s === 'string') {
        try {
            s = JSON.parse(s);
        } catch {
            return [];
        }
    }
    return (Array.isArray(s) ? s : []).filter((x) => x && typeof x === 'object' && typeof x.suggestionContent === 'string' && x.suggestionContent.trim());
}

function main() {
    const batches = [];
    for (const model of fs.readdirSync(PAYLOADS).sort()) {
        for (const file of fs.readdirSync(path.join(PAYLOADS, model)).filter((f) => f.endsWith('.json')).sort()) {
            const { caseId, ends } = JSON.parse(fs.readFileSync(path.join(PAYLOADS, model, file), 'utf8'));
            const best = ends.map((end, i) => ({ i, list: findings(end) })).sort((a, b) => b.list.length - a.list.length)[0];
            if (!best || !best.list.length) continue;
            batches.push({
                id: `${model}/${caseId}`,
                source: `evals/parse/payloads/${model}/${file}#${best.i}`,
                findings: best.list.map((s) => ({
                    title: s.oneSentenceSummary || '',
                    suggestionContent: s.suggestionContent,
                    existingCode: typeof s.existingCode === 'string' ? s.existingCode : '',
                    improvedCode: typeof s.improvedCode === 'string' ? s.improvedCode : '',
                    relevantFile: s.relevantFile || '',
                    language: s.language || '',
                })),
            });
        }
    }
    const cases = Object.keys(VARIANTS).flatMap((variant) => batches.map((b) => ({ id: `${variant}/${b.id}`, batch: b.id, variant })));
    fs.writeFileSync(path.join(__dirname, 'batches.json'), `${JSON.stringify(batches, null, 2)}\n`);
    fs.writeFileSync(path.join(__dirname, 'cases.json'), `${JSON.stringify(cases, null, 2)}\n`);
    const n = batches.reduce((a, b) => a + b.findings.length, 0);
    console.log(`wrote ${batches.length} batches (${n} findings) and ${cases.length} cases`);
    return 0;
}

process.exit(main());
