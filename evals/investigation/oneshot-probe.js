#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Asks the benchmarked model, one golden at a time, whether it can find a
 * defect the full harness missed — with the search collapsed to nothing.
 *
 * The harness gives an agent 34 detection items, every changed file, tools, and
 * a dozen steps. This gives it ONE file's diff and the detection categories,
 * in a single call with no tools and no loop. Everything that could dilute
 * attention is gone.
 *
 * It separates two explanations that fifteen configurations could not tell
 * apart. If the model reports the defect here, the miss is about search and
 * prioritisation — it can see the bug but never gets there on its own. If it
 * does not report it even here, no architecture built on this model will.
 *
 * Deliberately NOT told what the golden says: the prompt carries the same
 * category definitions the agents already have, nothing more. Telling it the
 * answer would measure reading comprehension.
 *
 * Usage:
 *   node evals/investigation/oneshot-probe.js [--limit=N] [--out=file.json]
 */
const fs = require('fs');
const path = require('path');
const { generateText } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT } = require('@libs/common/utils/codeReview/v2Defaults');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const LIMIT = Number(arg('limit', '0'));
const OUT = arg('out', path.join(__dirname, 'results', 'oneshot-probe.json'));
const MODEL = process.env.RECALL_MODEL || 'gpt-5.6-sol';
const RESULTS = path.join(__dirname, 'results');
const DATASETS = path.join(__dirname, 'datasets');

const K = (s) => String(s).replace(/«[^»]*»/g, '').slice(0, 55).trim();
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);

const BIG = new Set([
    'frontend-asset-optimization-grafana-codex',
    'replays-self-serve-bulk-delete-system-sentry',
    'notification-rule-processing-engine-grafana-codex',
    'anonymous-add-configurable-device-limit-grafana-codex',
]);

/** The file a golden is about, inferred from the identifiers it names. Goldens
 *  carry no path, so this is a heuristic; the count of unattributable ones is
 *  reported rather than hidden, because they are the ones a reader should
 *  discount. */
function locate(comment, files) {
    const t = new Set();
    for (const m of comment.matchAll(/`([^`]{3,60})`/g)) t.add(m[1].trim());
    for (const m of comment.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:[A-Z][a-z0-9]|_[a-z0-9])[A-Za-z0-9_]*)\b/g))
        if (m[1].length >= 6) t.add(m[1]);
    for (const m of comment.matchAll(/\b([\w.\-/]+\.(?:go|ts|tsx|js|jsx|py|java|rb|scss|css|erb))\b/g)) t.add(m[1]);
    let best = null, bn = 0;
    for (const f of files) {
        const body = f.patchWithLinesStr || '';
        let n = 0;
        for (const x of t) if (x && body.includes(x)) n++;
        for (const x of t) if (x && f.filename.includes(x)) n += 3;
        if (n > bn) { bn = n; best = f; }
    }
    return bn >= 2 ? best : null;
}

const CATS = Object.values(V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT).join('\n');

function prompt(file) {
    return `You are reviewing ONE file from a pull request. Everything you need is below — there are no tools and no follow-up turns.

<Diff>
--- ${file.filename} ---
${file.patchWithLinesStr}
</Diff>

<WhatCountsAsADefect>
${CATS}
</WhatCountsAsADefect>

<Task>
List every defect you can find in the lines this diff adds or modifies. Be exhaustive: this is the only pass over this file, so a defect you leave out is lost.

For each one, write two lines:
  WHAT: the exact problem, naming the symbol and the line.
  WHY: what breaks because of it.

A change being intentional does not make it correct. Do not report style, naming preferences, or anything you cannot point at a concrete failure for. If the file is genuinely clean, say so.
</Task>`;
}

(async () => {
    // Which goldens the 15-agent run missed, outside the four big PRs.
    const rows = {};
    for (const f of ['m14-run.json', 'm14-rest25.json', 'quota1.json', 'm14-rest8.json']) {
        for (const r of JSON.parse(fs.readFileSync(path.join(RESULTS, f), 'utf8')).rows) {
            if (r.status !== 'infra') rows[r.caseId] = r;
        }
    }
    const targets = [];
    for (const file of fs.readdirSync(DATASETS)) {
        if (!file.endsWith('.json')) continue;
        let vars;
        try { vars = JSON.parse(fs.readFileSync(path.join(DATASETS, file), 'utf8'))[0].vars; } catch { continue; }
        const r = rows[vars?.caseId];
        if (!r || BIG.has(vars.caseId)) continue;
        const m = String(r.reason || '').match(/missed\[[^\]]*\]:\s*(.*)$/);
        const missed = new Set(m ? m[1].split(' | ').map(K) : []);
        const files = J(vars.changedFilesFull);
        for (const g of J(vars.goldenComments)) {
            if (!missed.has(K(g.comment))) continue;
            const hit = locate(g.comment, files);
            targets.push({ caseId: vars.caseId, severity: g.severity, golden: g.comment, file: hit });
        }
    }

    const doable = targets.filter((t) => t.file);
    console.log(`${targets.length} goldens perdidos · ${doable.length} com arquivo localizado · ${targets.length - doable.length} sem localizar\n`);

    const model = buildModel(MODEL);
    console.log(`[modelo] ${descreveModelo(MODEL)}`);
    const list = LIMIT ? doable.slice(0, LIMIT) : doable;
    const out = [];
    let tokens = 0;

    for (const [i, t] of list.entries()) {
        process.stdout.write(`[${i + 1}/${list.length}] ${t.file.filename.split('/').pop().slice(0, 34).padEnd(34)} `);
        try {
            const res = await generateText({ model, prompt: prompt(t.file), maxRetries: 2 });
            tokens += (res.usage?.inputTokens || 0) + (res.usage?.outputTokens || 0);
            out.push({ ...t, file: t.file.filename, answer: res.text });
            console.log(`${String(res.text || '').length} chars`);
        } catch (err) {
            out.push({ ...t, file: t.file.filename, answer: null, error: String(err.message || err).slice(0, 200) });
            console.log(`ERRO: ${String(err.message || err).slice(0, 70)}`);
        }
    }
    fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, tokens, probes: out }, null, 2));
    console.log(`\n${out.length} sondagens · ${tokens.toLocaleString('pt-BR')} tokens\n-> ${OUT}`);
})();
