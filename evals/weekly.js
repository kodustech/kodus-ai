#!/usr/bin/env node
// The weekly run (evals/README.md, "When it runs"): every eval of
// evals/nightly-evals.js WEEKLY_EVALS on one model and one set, each against
// that model's floor, a run below it measured again before it counts. With
// --tests, also the contract tests a stage repeats on every model
// (evals/stages.js tests with `weekly`).
//
//   node evals/weekly.js --model=<id> --set=controlled|full [--only=<eval id,…>] [--tests] --out=<dir>
//   node evals/weekly.js --plan                 the workflow's matrix (JSON)
//   node evals/weekly.js --report=<dir>         the message, from every job's summary.json under <dir>
//
// Every tier-0 model runs the controlled set; DeepSeek also runs the full one.
// Writes, under <dir>: <eval id>/{first,confirm,final}.json, rows.json (the
// rows of evals/stage-signals.js weeklyRows and weeklyTestRows, for
// .github/actions/report-signal) and summary.json.
//
// Exit: 0 every eval measured at or above its floor, or oscillated, or has no
// floor for the model yet; 1 one fell below on both runs, or a contract test
// failed; 2 one did not measure.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { WEEKLY_EVALS } = require('./nightly-evals');
const { STAGES } = require('./stages');
const { weeklyRows, weeklyTestRows } = require('./stage-signals');
const { tier0 } = require('./shared/tier0-models');

const ROOT = path.join(__dirname, '..');
// The model that also runs the full sets: the nightly's.
const FULL_MODEL = 'deepseek-v4-flash@fireworks';

// One job per model, set and part, so a slow model's agent reviews do not hold
// the rest. Every WEEKLY_EVALS id is in one part (evals/weekly.spec.ts).
const PARTS = [
    { part: 'finder', evals: ['finder-recall'] },
    { part: 'kody-rules', evals: ['kody-rules'] },
    { part: 'funnel', evals: ['funnel-verify', 'funnel-dedup', 'funnel-severity'] },
    { part: 'conversation', evals: ['conversation', 'thread-rule', 'thread-memory', 'reply-addressing'] },
    { part: 'review', evals: ['review-rounds', 'format', 'memories', 'business-logic'], tests: true },
];

// The matrix: every tier-0 model on the controlled set, the nightly's model on
// the full set too (only the parts with a full set).
function plan(models = tier0()) {
    const hasFull = (id) => Boolean(WEEKLY_EVALS.find((e) => e.id === id)?.sets.full);
    const jobs = [];
    for (const model of models) {
        for (const p of PARTS) jobs.push({ model, set: 'controlled', part: p.part, only: p.evals.join(','), tests: Boolean(p.tests) });
        if (model !== FULL_MODEL) continue;
        for (const p of PARTS) {
            const full = p.evals.filter(hasFull);
            if (full.length) jobs.push({ model, set: 'full', part: p.part, only: full.join(','), tests: false });
        }
    }
    return jobs;
}

const SIGN = { pass: '🟢', oscillation: '🟡', ungated: '⚪', regression: '🔴', 'still-red': '🔴', infra: '⚠️' };

// The week's message: what fell below a floor, what did not measure, per model.
function report(dir) {
    const summaries = [];
    const walk = (d) => {
        for (const name of fs.existsSync(d) ? fs.readdirSync(d) : []) {
            const full = path.join(d, name);
            if (fs.statSync(full).isDirectory()) walk(full);
            else if (name === 'summary.json') summaries.push(readJson(full));
        }
    };
    walk(dir);
    const cells = summaries.filter(Boolean).flatMap((s) => s.results.map((r) => ({ ...r, model: s.model, set: s.set })));
    const red = cells.filter((c) => c.verdict === 'regression' || c.verdict === 'still-red');
    const infra = cells.filter((c) => c.verdict === 'infra');
    const line = (c) => `${SIGN[c.verdict] || '·'} \`${c.model}\` ${c.stage}${c.set === 'full' ? ' (full set)' : ''}${Number.isFinite(c.value) ? ` ${Math.round(c.value * 100)}%` : ''}${Number.isFinite(c.floor) ? ` · floor ${Math.round(c.floor * 100)}%` : ''}`;
    const models = [...new Set(cells.map((c) => c.model))];
    const status = red.length ? 'failure' : infra.length || !cells.length ? 'cancelled' : 'success';
    const title = !cells.length
        ? '⚠️ Weekly evals: no result'
        : red.length
          ? `🔴 Weekly evals: ${red.length} below the floor`
          : infra.length
            ? `⚠️ Weekly evals: ${infra.length} not measured`
            : `🟢 Weekly evals: every step at or above its floor on ${models.length} models`;
    const description = [...red.map(line), ...infra.map(line)].join('\n') || `${cells.length} measures, ${cells.filter((c) => c.verdict === 'ungated').length} with no floor for the model yet.`;
    return { status, title, description, cells };
}

function parseArgs(argv) {
    return Object.fromEntries(
        argv.slice(2).map((a) => {
            const m = a.match(/^--([^=]+)(?:=(.*))?$/);
            return m ? [m[1], m[2] ?? true] : [a, true];
        }),
    );
}

const readJson = (file) => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
};

function node(args) {
    console.log(`$ node ${args.join(' ')}`);
    const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
    return r.status ?? 2;
}

// The finder's verdict: its own gate (gate.js) and confirmation (confirm-gate.js).
function finderVerdict(entry, set, files, firstCode, measure) {
    const first = readJson(files.first);
    if (firstCode === 0) return { verdict: 'pass', final: files.first };
    if (firstCode === 2) {
        // No floor for this model on this set: measured, not compared.
        const ungated = first && first.gate?.status === 'skipped' && /^no target/.test(first.gate.reason || '');
        return { verdict: ungated ? 'ungated' : 'infra', final: files.first };
    }
    measure(files.confirm);
    const code = node(['evals/investigation/confirm-gate.js', files.first, files.confirm, `--out=${files.final}`, `--set=${set}`]);
    return { verdict: { 0: 'oscillation', 1: 'regression' }[code] || 'infra', final: fs.existsSync(files.final) ? files.final : files.first };
}

// Kody Rules and the shared evals: their nightly verdict scripts, which pool the
// two runs and write the final result with its verdict.
function scriptVerdict(entry, files, firstCode, measure) {
    if (firstCode === 1) measure(files.confirm);
    const script = entry.verdict === 'kody-rules' ? 'evals/kody-rules/nightly-verdict.js' : 'evals/shared/nightly-verdict.js';
    const args = [script, ...(entry.verdict === 'shared' ? [`--eval=${entry.id}`] : []), `--first=${files.first}`];
    if (firstCode === 1) args.push(`--confirm=${files.confirm}`);
    node([...args, `--out=${files.final}`, `--state=${files.state}`]);
    return { verdict: readJson(files.final)?.verdict || 'infra', final: files.final };
}

function runEval(entry, { model, set, out }) {
    const dir = path.join(out, entry.id);
    fs.mkdirSync(dir, { recursive: true });
    const files = Object.fromEntries(['first', 'confirm', 'final', 'state'].map((k) => [k, path.join(dir, `${k}.json`)]));
    const measure = (file) => node([...entry.run, ...entry.sets[set], `--model=${model}`, '--gate', `--output=${file}`]);
    const firstCode = measure(files.first);
    const { verdict, final } = entry.verdict === 'finder' ? finderVerdict(entry, set, files, firstCode, measure) : scriptVerdict(entry, files, firstCode, measure);
    const rows = weeklyRows(readJson(final), verdict, { stageId: entry.stage, model, set });
    return { id: entry.id, stage: entry.stage, verdict, value: rows[0]?.value ?? null, floor: rows[0]?.meta?.floor ?? null, rows };
}

function runTest(stage, test, { model }) {
    const code = node([...test.weekly, `--model=${model}`]);
    const rows = weeklyTestRows({ stageId: stage.id, model, exit: code, problem: code === 0 ? null : `exit ${code}` });
    return { id: `${stage.id}:test`, stage: stage.id, verdict: code === 0 ? 'pass' : code === 1 ? 'regression' : 'infra', rows };
}

function main() {
    const args = parseArgs(process.argv);
    if (args.plan) {
        console.log(JSON.stringify(plan()));
        return 0;
    }
    if (args.report) {
        const r = report(String(args.report));
        if (process.env.GITHUB_OUTPUT) {
            const eof = `EOF_${Date.now()}`;
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${r.status}\ntitle=${r.title}\ndescription<<${eof}\n${r.description}\n${eof}\n`);
        }
        console.log(`${r.title}\n${r.description}`);
        return 0;
    }
    const { model, set, out } = args;
    if (!model || !['controlled', 'full'].includes(set) || !out) {
        console.error('usage: weekly.js --model=<id> --set=controlled|full [--only=<eval id,…>] [--tests] --out=<dir>');
        return 2;
    }
    const only = args.only ? new Set(String(args.only).split(',')) : null;
    const unknown = only ? [...only].filter((id) => !WEEKLY_EVALS.some((e) => e.id === id)) : [];
    if (unknown.length) {
        console.error(`unknown eval(s): ${unknown.join(', ')}`);
        return 2;
    }
    fs.mkdirSync(out, { recursive: true });
    const entries = WEEKLY_EVALS.filter((e) => e.sets[set] && (!only || only.has(e.id)));
    const results = entries.map((e) => runEval(e, { model, set, out }));
    if (args.tests && set === 'controlled') {
        for (const stage of STAGES) for (const test of stage.tests.filter((t) => t.weekly)) results.push(runTest(stage, test, { model }));
    }
    fs.writeFileSync(path.join(out, 'rows.json'), `${JSON.stringify(results.flatMap((r) => r.rows), null, 2)}\n`);
    const summary = results.map(({ rows: _rows, ...r }) => r);
    fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify({ model, set, results: summary }, null, 2)}\n`);
    for (const r of summary) console.log(`${r.verdict.padEnd(11)} ${r.id}${r.value === null || r.value === undefined ? '' : ` ${r.value.toFixed(3)}`}${r.floor === null || r.floor === undefined ? '' : ` (floor ${r.floor})`}`);
    if (summary.some((r) => r.verdict === 'regression' || r.verdict === 'still-red')) return 1;
    if (summary.some((r) => r.verdict === 'infra')) return 2;
    return 0;
}

if (require.main === module) process.exit(main());

module.exports = { main, plan, report, PARTS, FULL_MODEL };
