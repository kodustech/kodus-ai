#!/usr/bin/env node
/**
 * Runs a severity prompt (prompts.js; `prod` is production's) over the severity
 * dataset and scores it per level.
 *
 *   RECALL_MODEL=<tier0 id> node evals/severity/run.js [--prompt=prod] [--par=4]
 *     -> evals/severity/results/<prompt>/<model>.json
 *
 * One call per PR with that PR's items, as production sends one call per
 * review. The suggestion text is taken as true: whether the problem exists is
 * the verifier's question, not this step's.
 *
 * Right answer per gold level: low, medium and high exact (critical for a high
 * is wrong); a critical answered high or critical is right (8 cases, too few to
 * tell those two apart).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { LLM } = require(path.join(__dirname, '../../libs/llm/llm.ts'));
const { parseSeverityResponse } = require(path.join(__dirname, '../../libs/code-review/infrastructure/agents/engine/severity-prompt.ts'));
const { createModel } = require('../investigation/agent-provider-1821');
const PROMPTS = require('./prompts');

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d;
const MODEL = process.env.RECALL_MODEL;
const PAR = Number(arg('par', 4));
const PROMPT = arg('prompt', 'prod');
const SAMPLES = Number(arg('samples', 1));
// --single: one call per suggestion instead of one per PR.
const SINGLE = process.argv.includes('--single');
const OUT = arg('out', path.join(__dirname, 'results', `${PROMPT}${SINGLE ? '-1' : ''}${SAMPLES > 1 ? `x${SAMPLES}` : ''}`, `${(MODEL || '').replace(/[^\w.-]+/g, '_')}.json`));
if (!MODEL || !PROMPTS[PROMPT]) {
    console.error(`RECALL_MODEL=<id> --prompt=${Object.keys(PROMPTS).join('|')}`);
    process.exit(2);
}
const LEVELS = ['low', 'medium', 'high', 'critical'];
const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset/items.json'), 'utf8')).items;
const REPOS = JSON.parse(fs.readFileSync(path.join(__dirname, '../dedup/gold-v3/trabalho/repos.json'), 'utf8'));
const right = (gold, got) => (gold === 'critical' ? got === 'high' || got === 'critical' : got === gold);

// The head file around the cited lines; "+" marks lines the PR changed, ">" the cited ones.
function excerpt(it) {
    const { repo, base, head } = REPOS[it.caseId];
    const f = it.finding;
    const a = f.relevantLinesStart;
    const e = f.relevantLinesEnd || a;
    if (!f.relevantFile || !a) return '';
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    let lines;
    try {
        lines = git('show', `${head}:${f.relevantFile}`).split('\n');
    } catch {
        return '';
    }
    const changed = new Set();
    for (const m of git('diff', '-U0', `${base}...${head}`, '--', f.relevantFile).matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
        const s = Number(m[1]);
        const n = m[2] === undefined ? 1 : Number(m[2]);
        for (let i = s; i < s + n; i++) changed.add(i);
    }
    const out = [];
    for (let i = Math.max(1, a - 10); i <= Math.min(lines.length, e + 10); i++) {
        out.push(`${changed.has(i) ? '+' : ' '}${i >= a && i <= e ? '>' : ' '}${String(i).padStart(5)}| ${lines[i - 1]}`);
    }
    return out.join('\n');
}

const view = (it) => ({
    file: it.finding.relevantFile,
    lines: it.finding.relevantLinesStart ? `${it.finding.relevantLinesStart}-${it.finding.relevantLinesEnd || it.finding.relevantLinesStart}` : '',
    text: it.finding.suggestionContent,
    label: it.label,
    excerpt: excerpt(it),
});

async function sample(list, model) {
    let last = '';
    // A dropped connection or an unreadable answer is retried; production would
    // fall back to medium for the whole PR instead.
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const text = await LLM.run({ user: PROMPTS[PROMPT].build(list.map(view)), prebuiltModel: model, runName: 'eval-severity' });
            const { classifications, parseOk } = parseSeverityResponse(text || '');
            if (parseOk) return { got: classifications };
            last = `unparsed: ${String(text).slice(0, 300)}`;
        } catch (e) {
            last = String(e?.message || e).slice(0, 200);
        }
    }
    return { error: last };
}

// Majority of the samples; a tie goes to the median of the votes.
function vote(votes) {
    const ok = votes.filter((v) => LEVELS.includes(v));
    if (!ok.length) return null;
    const count = new Map();
    for (const v of ok) count.set(v, (count.get(v) || 0) + 1);
    const top = Math.max(...count.values());
    const tied = [...count].filter(([, n]) => n === top).map(([v]) => v);
    if (tied.length === 1) return tied[0];
    const sorted = ok.map((v) => LEVELS.indexOf(v)).sort((a, b) => a - b);
    return LEVELS[sorted[Math.floor((sorted.length - 1) / 2)]];
}

async function one(list, model) {
    const t0 = Date.now();
    const runs = await Promise.all(Array.from({ length: SAMPLES }, () => sample(list, model)));
    if (runs.every((r) => r.error)) return list.map((it) => ({ issueId: it.issueId, gold: it.severity, got: null, error: runs[0].error }));
    return list.map((it, i) => {
        const votes = runs.map((r) => r.got?.get(i) ?? null);
        return { issueId: it.issueId, gold: it.severity, got: vote(votes), ...(SAMPLES > 1 && { votes }), ms: Date.now() - t0 };
    });
}

(async () => {
    if (process.argv.includes('--dry')) {
        console.log(PROMPTS[PROMPT].build(items.filter((x) => x.caseId === items[0].caseId).map(view)));
        process.exit(0);
    }
    const model = await createModel({ provider: 'tier0' });
    const byCase = new Map();
    for (const it of items) (byCase.get(it.caseId) || byCase.set(it.caseId, []).get(it.caseId)).push(it);
    const todo = SINGLE ? items.map((it) => [it]) : [...byCase.values()];
    const rows = [];
    let i = 0;
    await Promise.all(Array.from({ length: PAR }, async () => {
        while (i < todo.length) rows.push(...(await one(todo[i++], model)));
    }));
    const measured = rows.filter((r) => LEVELS.includes(r.got));
    const perLevel = Object.fromEntries(LEVELS.map((l) => {
        const xs = measured.filter((r) => r.gold === l);
        return [l, { n: xs.length, right: xs.filter((r) => right(r.gold, r.got)).length, got: Object.fromEntries(LEVELS.map((g) => [g, xs.filter((r) => r.got === g).length])) }];
    }));
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, prompt: PROMPT, perLevel, unmeasured: rows.length - measured.length, rows }, null, 1));
    console.log(`${MODEL} ${PROMPT}`);
    for (const l of LEVELS) console.log(`  ${l.padEnd(8)} ${perLevel[l].right}/${perLevel[l].n}  ${JSON.stringify(perLevel[l].got)}`);
    console.log(`  unmeasured: ${rows.length - measured.length}`);
    process.exit(rows.length - measured.length > rows.length * 0.05 ? 2 : 0);
})();
