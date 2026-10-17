#!/usr/bin/env node
// An experiment: one review step on two versions of production's code, the
// same evals, cases, model and judge on both sides (evals/README.md,
// "Experiments"). The base is where the branch left its base ref; the
// candidate is the branch's HEAD, committed. Each side runs every eval of the
// step `--runs` times, alternating, and the comparison is per case, paired:
// the difference of the pooled metric with a bootstrap interval over the
// cases, and the cases that got worse or better.
//
//   node evals/experiment.js --step=dedup [--base=origin/main] [--runs=2] [--model=<id>] [--name=<label>] [--out=<dir>]
//
// What each side ran is recorded, never assumed:
//   step version     a hash of the production files the evals loaded on that
//                    side (evals/shared/trace-loaded.js) at their committed
//                    content; equal on both sides means the branch did not
//                    change this step;
//   eval and dataset the eval's own files must be the same commit content on
//                    both sides, or there is nothing to compare;
//   environment      what each eval reports of it (the dedup's embedder).
//
// Writes, under --out: experiment.json, rows.json (experiments.<step>.<eval>.<name>,
// for the quality panel) and each run's result. Exit: 0 compared, 2 could not.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// The evals an experiment on a step runs: the one that answers whether the
// change is better, and the ones that must not get worse.
const STEP_EVALS = {
    dedup: {
        primary: { id: 'dedup-groups', run: ['evals/dedup-groups/run.js'], question: 'Does the dedup join the suggestions that report the same problem, and only those?' },
        guards: [{ id: 'funnel-dedup', run: ['evals/funnel/dedup/run.js', '--set=full'], question: 'Of the known bugs reaching the dedup in a real review, how many does it keep?' }],
    },
};

const parseArgs = (argv) =>
    Object.fromEntries(
        argv.map((a) => {
            const m = a.match(/^--([^=]+)(?:=(.*))?$/);
            return m ? [m[1], m[2] ?? true] : [a, true];
        }),
    );
const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
const readJson = (file) => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
};
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const hash = (lines) => crypto.createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 12);

// Seeded, so the same runs give the same interval.
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Per case, summed over a side's runs: the hits and totals of every run that measured it.
function perCase(runs) {
    const byId = new Map();
    for (const run of runs) {
        for (const c of run?.cases || []) {
            if (c.unmeasured) continue;
            const prev = byId.get(c.id) || { hits: 0, total: 0, runs: 0, checks: c.checks };
            byId.set(c.id, { ...prev, hits: prev.hits + c.hits, total: prev.total + c.total, runs: prev.runs + 1 });
        }
    }
    return byId;
}

/**
 * The paired comparison of one eval: over the cases both sides measured in
 * every run, each side's pooled metric, the candidate minus the base, a 95%
 * bootstrap interval of that difference resampling cases, the run-to-run
 * spread of each side, and the cases that moved.
 */
function compare(baseRuns, candidateRuns, { seed = 1 } = {}) {
    const runsEach = Math.min(baseRuns.length, candidateRuns.length);
    const base = perCase(baseRuns);
    const cand = perCase(candidateRuns);
    const ids = [...base.keys()].filter((id) => cand.has(id) && base.get(id).runs === baseRuns.length && cand.get(id).runs === candidateRuns.length && base.get(id).total + cand.get(id).total > 0);
    const pooled = (side, sample) => {
        const hits = sample.reduce((n, id) => n + side.get(id).hits, 0);
        const total = sample.reduce((n, id) => n + side.get(id).total, 0);
        return total ? hits / total : null;
    };
    const baseValue = pooled(base, ids);
    const candValue = pooled(cand, ids);
    const diff = baseValue === null || candValue === null ? null : candValue - baseValue;
    const random = rng(seed);
    const diffs = [];
    for (let b = 0; b < 2000 && ids.length; b++) {
        const sample = ids.map(() => ids[Math.floor(random() * ids.length)]);
        const d = pooled(cand, sample) - pooled(base, sample);
        if (Number.isFinite(d)) diffs.push(d);
    }
    diffs.sort((x, y) => x - y);
    const ci = diffs.length ? [diffs[Math.floor(diffs.length * 0.025)], diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * 0.975))]] : null;
    // How much one side moves between its own runs: the noise a difference has to beat.
    const spread = (runs) => {
        const values = runs.map((r) => {
            const one = perCase([r]);
            return pooled(one, ids.filter((id) => one.has(id)));
        }).filter(Number.isFinite);
        return values.length > 1 ? Math.max(...values) - Math.min(...values) : null;
    };
    const ratio = (side, id) => side.get(id).hits / side.get(id).total;
    const moved = ids
        .filter((id) => base.get(id).total > 0 && cand.get(id).total > 0)
        .map((id) => ({ id, checks: cand.get(id).checks, base: ratio(base, id), candidate: ratio(cand, id) }))
        .filter((c) => c.base !== c.candidate);
    const verdict = !ci ? 'not measured' : ci[0] > 0 ? 'better' : ci[1] < 0 ? 'worse' : 'tie';
    return {
        cases: ids.length,
        runsEach,
        base: baseValue,
        candidate: candValue,
        diff,
        ci,
        noise: { base: spread(baseRuns), candidate: spread(candidateRuns) },
        worse: moved.filter((c) => c.candidate < c.base).sort((a, b) => a.candidate - a.base - (b.candidate - b.base)),
        better: moved.filter((c) => c.candidate > c.base).sort((a, b) => b.candidate - b.base - (a.candidate - a.base)),
        verdict,
    };
}

// The mean of each side's secondary metrics and model usage over its runs.
function sideSummary(runs) {
    const ok = runs.filter(Boolean);
    const mean = (pick) => {
        const values = ok.map(pick).filter(Number.isFinite);
        return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    };
    const metricKeys = [...new Set(ok.flatMap((r) => Object.keys(r.metrics || {})))];
    return {
        metrics: Object.fromEntries(metricKeys.map((k) => [k, mean((r) => r.metrics?.[k])])),
        usage: Object.fromEntries(['calls', 'in', 'cacheRead', 'cacheWrite', 'out', 'ms'].map((k) => [k, mean((r) => r.tokens?.[k])])),
        environment: ok.map((r) => r.environment).find(Boolean) || null,
        cases: mean((r) => (r.cases || []).length),
    };
}

// The production files a side's evals loaded, with their committed content.
function versionOf(sha, files) {
    const prod = [...files].filter((f) => /^(libs|apps|packages)\//.test(f)).sort();
    const evalFiles = [...files].filter((f) => /^evals\//.test(f)).sort();
    const blobs = (list) => {
        if (!list.length) return new Map();
        const out = git(['ls-tree', '-r', sha, '--', ...list]);
        return new Map(out.split('\n').filter(Boolean).map((l) => { const [meta, file] = l.split('\t'); return [file, meta.split(' ')[2]]; }));
    };
    const prodBlobs = blobs(prod);
    const evalBlobs = blobs(evalFiles);
    const data = evalFiles.filter((f) => /\/(cases|datasets|snapshot)\/|cases\.json$/.test(f));
    return {
        step: hash(prod.map((f) => `${f}:${prodBlobs.get(f) || 'missing'}`)),
        eval: hash(evalFiles.filter((f) => !data.includes(f)).map((f) => `${f}:${evalBlobs.get(f) || 'missing'}`)),
        dataset: hash(data.map((f) => `${f}:${evalBlobs.get(f) || 'missing'}`)),
        prodBlobs,
    };
}

function readTraces(dir) {
    const files = new Set();
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        for (const f of fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean)) files.add(f);
    }
    return files;
}

function runEval(entry, { side, dir, model, out, round, trace }) {
    const output = path.join(out, side, `${entry.id}.r${round}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const traceDir = path.join(trace, `${side}-${entry.id}-r${round}`);
    const log = fs.openSync(path.join(out, side, `${entry.id}.r${round}.log`), 'w');
    console.log(`  ${side.padEnd(9)} ${entry.id} run ${round}`);
    const r = spawnSync(process.execPath, [...entry.run, `--model=${model}`, `--output=${output}`], {
        cwd: dir,
        stdio: ['ignore', log, log],
        env: {
            ...process.env,
            TRACE_LOADED_DIR: traceDir,
            TRACE_LOADED_LABEL: entry.id,
            NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${path.join(dir, 'evals', 'shared', 'trace-loaded.js')}`.trim(),
        },
    });
    fs.closeSync(log);
    return { result: readJson(output), exit: r.status ?? 2, traceDir };
}

function decide(step, primary, guards, sides, versions) {
    if (versions.base.step === versions.candidate.step) return { decision: 'no change in this step', reason: 'the branch did not change a production file this step loads' };
    const guardWorse = guards.filter((g) => g.comparison.verdict === 'worse' || g.comparison.worse.length);
    if (primary.comparison.verdict === 'not measured' || guards.some((g) => g.comparison.verdict === 'not measured')) return { decision: 'not measured', reason: 'an eval did not measure on both sides' };
    if (guardWorse.length) return { decision: 'does not ship', reason: `${guardWorse.map((g) => `${g.id}: ${g.comparison.worse.length} case${g.comparison.worse.length === 1 ? '' : 's'} worse`).join('; ')}` };
    if (primary.comparison.verdict === 'better') return { decision: 'ships', reason: `${primary.id} is better beyond its interval, and no guard got worse` };
    const cheaper = (sides.candidate.usage.in || 0) + (sides.candidate.usage.out || 0) < (sides.base.usage.in || 0) + (sides.base.usage.out || 0);
    if (primary.comparison.verdict === 'tie' && cheaper) return { decision: 'ships', reason: `${primary.id} ties and the candidate uses fewer tokens` };
    return { decision: 'does not ship', reason: primary.comparison.verdict === 'worse' ? `${primary.id} is worse beyond its interval` : `${primary.id} ties and the candidate is not cheaper` };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const step = args.step;
    const plan = STEP_EVALS[step];
    if (!plan) {
        console.error(`usage: experiment.js --step=<${Object.keys(STEP_EVALS).join('|')}> [--base=origin/main] [--runs=2] [--model=<id>] [--name=<label>] [--out=<dir>]`);
        return 2;
    }
    const model = args.model || 'deepseek-v4-flash@fireworks';
    const runs = Math.max(1, Number(args.runs) || 2);
    const baseRef = args.base || 'origin/main';
    // What ran must be a commit: uncommitted changes would make the result point at code that does not exist.
    const dirty = git(['status', '--porcelain', '--untracked-files=no']);
    if (dirty) {
        console.error(`commit first: the candidate is HEAD, and these changes are not in it:\n${dirty}`);
        return 2;
    }
    const head = git(['rev-parse', 'HEAD']);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const baseSha = git(['merge-base', head, baseRef]);
    if (baseSha === head) {
        console.error(`nothing to compare: HEAD is where it left ${baseRef}`);
        return 2;
    }
    const evalDiff = git(['diff', '--name-only', baseSha, head, '--', 'evals']);
    if (evalDiff) {
        console.error(`not comparable: the evals differ between the two sides; land the eval change on ${baseRef} first:\n${evalDiff}`);
        return 2;
    }
    const name = slug(args.name || branch);
    const out = path.resolve(args.out || path.join(os.tmpdir(), 'kodus-experiments', `${step}-${name}-${Date.now()}`));
    const trace = path.join(out, 'trace');
    const baseDir = path.join(out, 'base-tree');
    fs.mkdirSync(out, { recursive: true });
    console.log(`experiment ${step} · ${name}: base ${baseSha.slice(0, 9)} (${baseRef}) vs candidate ${head.slice(0, 9)} (${branch}) · ${model} · ${runs} runs each · ${out}`);

    git(['worktree', 'add', '--detach', baseDir, baseSha]);
    try {
        fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(baseDir, 'node_modules'));
        // The EE config is gitignored; production code reads it at import time.
        const ee = 'libs/ee/configs/environment/environment.ts';
        if (fs.existsSync(path.join(ROOT, ee))) fs.copyFileSync(path.join(ROOT, ee), path.join(baseDir, ee));

        const entries = [plan.primary, ...plan.guards];
        const results = Object.fromEntries(entries.map((e) => [e.id, { base: [], candidate: [] }]));
        const traces = { base: new Set(), candidate: new Set() };
        const exits = [];
        for (let round = 1; round <= runs; round++) {
            for (const side of ['base', 'candidate']) {
                for (const entry of entries) {
                    const r = runEval(entry, { side, dir: side === 'base' ? baseDir : ROOT, model, out, round, trace });
                    exits.push({ side, eval: entry.id, round, exit: r.exit });
                    results[entry.id][side].push(r.result && r.exit !== 2 ? r.result : null);
                    for (const f of readTraces(r.traceDir)) traces[side].add(f);
                }
            }
        }

        const versions = { base: versionOf(baseSha, traces.base), candidate: versionOf(head, traces.candidate) };
        const allProd = [...new Set([...versions.base.prodBlobs.keys(), ...versions.candidate.prodBlobs.keys()])];
        const changedFiles = allProd.filter((f) => versions.base.prodBlobs.get(f) !== versions.candidate.prodBlobs.get(f)).sort();
        const evalsOut = entries.map((entry, k) => {
            const r = results[entry.id];
            return {
                id: entry.id,
                role: k === 0 ? 'primary' : 'guard',
                question: entry.question,
                metric: (r.candidate.find(Boolean) || r.base.find(Boolean) || {}).metric?.name || null,
                comparison: compare(r.base.filter(Boolean), r.candidate.filter(Boolean)),
                sides: { base: sideSummary(r.base), candidate: sideSummary(r.candidate) },
                runValues: { base: r.base.map((x) => x?.metric?.value ?? null), candidate: r.candidate.map((x) => x?.metric?.value ?? null) },
            };
        });
        const [primary, ...guards] = evalsOut;
        const decision = decide(step, primary, guards, primary.sides, versions);
        const strip = ({ prodBlobs: _blobs, ...v }) => v;
        const experiment = {
            step,
            name,
            branch,
            baseRef,
            model,
            runs,
            createdAt: new Date().toISOString(),
            base: { sha: baseSha, version: strip(versions.base) },
            candidate: { sha: head, version: strip(versions.candidate) },
            changedFiles,
            evals: evalsOut,
            decision,
            exits,
        };
        fs.writeFileSync(path.join(out, 'experiment.json'), `${JSON.stringify(experiment, null, 2)}\n`);
        const STATUS = { better: 'green', tie: 'yellow', worse: 'red', 'not measured': 'infra' };
        const rows = evalsOut.map((e) => ({
            name: `experiments.${slug(step)}.${slug(e.id)}.${name}`,
            status: STATUS[e.comparison.verdict] || 'infra',
            value: e.comparison.diff,
            unit: 'ratio',
            meta: {
                stage: step,
                experiment: name,
                branch,
                eval: e.id,
                role: e.role,
                question: e.question,
                metric: e.metric,
                model,
                runs,
                base: { sha: baseSha, ref: baseRef, step_version: versions.base.step },
                candidate: { sha: head, step_version: versions.candidate.step },
                eval_version: versions.candidate.eval,
                dataset_version: versions.candidate.dataset,
                changed_files: changedFiles,
                comparison: { ...e.comparison, worse: e.comparison.worse.slice(0, 20), better: e.comparison.better.slice(0, 20), worseCount: e.comparison.worse.length, betterCount: e.comparison.better.length },
                sides: e.sides,
                run_values: e.runValues,
                decision: decision.decision,
                decision_reason: decision.reason,
            },
        }));
        fs.writeFileSync(path.join(out, 'rows.json'), `${JSON.stringify(rows, null, 2)}\n`);

        const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');
        const pp = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}` : 'n/a');
        console.log(`\nstep version: base ${versions.base.step}, candidate ${versions.candidate.step}${changedFiles.length ? ` (${changedFiles.length} files changed: ${changedFiles.slice(0, 4).join(', ')}${changedFiles.length > 4 ? ', …' : ''})` : ' — the same'}`);
        for (const e of evalsOut) {
            const c = e.comparison;
            console.log(`${e.role === 'primary' ? '★' : '·'} ${e.id}: base ${pct(c.base)} → candidate ${pct(c.candidate)}, ${pp(c.diff)} pp [${pp(c.ci?.[0])}, ${pp(c.ci?.[1])}] over ${c.cases} cases · ${c.verdict} · ${c.worse.length} worse, ${c.better.length} better · runs base ${e.runValues.base.map(pct).join('/')} candidate ${e.runValues.candidate.map(pct).join('/')}`);
        }
        console.log(`\ndecision: ${decision.decision} — ${decision.reason}\n${path.join(out, 'experiment.json')}`);
        return experiment.evals.every((e) => e.comparison.verdict !== 'not measured') ? 0 : 2;
    } finally {
        try {
            git(['worktree', 'remove', '--force', baseDir]);
        } catch {
            /* left for `git worktree prune` */
        }
    }
}

if (require.main === module) process.exit(main());

module.exports = { compare, perCase, decide, STEP_EVALS };
