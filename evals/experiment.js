#!/usr/bin/env node
// An experiment: one change to a review step, production's code on two sides
// (evals/README.md, "Experiments"): the base is where the branch left its base
// ref, the candidate is the branch's HEAD, committed. The same evals, cases,
// model and judge on both sides, each eval `--runs` times per side,
// alternating, compared per case, paired: the difference of the pooled metric
// with a bootstrap interval over the cases, and the cases that moved.
//
// It answers two questions, one after the other:
//   regression  Did it break anything? The main eval on the controlled set and
//               the evals that must not get worse. Fast; it catches a drop.
//   decision    Is it better? The main eval on the extended set: enough cases
//               for its interval to clear zero when the change is real.
// The decision: ships when nothing regressed and the decision phase is better
// beyond its interval (or ties and uses fewer tokens).
//
//   node evals/experiment.js --step=dedup [--phases=regression,decision] [--base=origin/main] [--runs=2] [--model=<id>] [--name=<label>] [--out=<dir>]
//   node evals/experiment.js --step=dedup --if-new ...   the same, unless the panel already has this code measured
//   node evals/experiment.js --step=finder --models=<id>,<id> ...   each model compared on its own; ships only if none got worse
//   node evals/experiment.js --step=finder --set=<name> ...         "is it better?" on a set of the step's own (its eval's
//                                                                  `sets` folder), or on a private one (an absolute path)
//   node evals/experiment.js --step=finder --team-config=<file> ... one commit, the team config off against on
//   node evals/experiment.js --affected --files-dir=<wiring smoke --eval-files-dir> --changed=<file of changed paths>
//                                               the steps whose production files a change touched (JSON), for a PR's check
//
// --phases       which questions to answer (both by default); a PR's check runs
//                the regression phase only, and the result says the decision was not run.
// --set          the cases "is it better?" runs on: the extended set by default; a
//                set of the step's own must be on the base ref first, like any eval
//                change; a private set (customer code stays out of this public
//                repository) is read by both sides from the same folder and recorded
//                by its content.
// --team-config  a JSON file of the review config keys a team saves: both sides run
//                HEAD, the base without it and the candidate with it (a capability a
//                team turns on). Recorded with its hash.
// --models       several models, each its own experiment, and one decision over
//                them: each customer runs one model, so a loss on any ships to its
//                customers.
// --cache-dir    where base-side runs are kept (~/.cache/kodus-evals/experiment-base):
//                the next experiment on the same base code, eval, set, model and
//                lockfile reuses them for up to 7 days; --fresh-base runs them again.
//
// What each side ran is recorded, never assumed:
//   step version     a hash of the production files the evals loaded on that
//                    side (evals/shared/trace-loaded.js) at their committed
//                    content; equal on both sides means the branch did not
//                    change this step;
//   eval and dataset the eval's own files must be the same commit content on
//                    both sides, or there is nothing to compare;
//   team config      the hash of what the candidate saved (--team-config), which
//                    each side's eval reports back;
//   environment      what each eval reports of it (the dedup's embedder).
//
// Writes, under --out: experiment.json, rows.json
// (experiments.<step>.<phase>.<eval>.<name>, for the quality panel), summary.md
// (the job summary in CI) and each run's result, and sends the rows to the
// quality panel (evals/shared/quality-client.js). With --if-new, code the panel
// already measured (the same content of every step file on both sides, the
// same phases) is not run again: the summary points at that result.
// Exit: 0 compared, 1 it broke
// something (the regression phase found a drop), 2 could not compare.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { TIER0 } = require('./shared/tier0-models');
const { sendExperimentRows, recordedExperiments, experimentsPage } = require('./shared/quality-client');
const { readTeamConfig, canonical } = require('./shared/team-config');
// The nightly's model (evals/README.md): an experiment's default.
const DEFAULT_MODEL = 'deepseek-v4-flash@fireworks';
const DEFAULT_RUNS = 2;
const MAX_RUNS = 10;

// The finder's result (evals/investigation/run-recall.js) in the shared shape
// the comparison reads: per PR, its known bugs shipped (hits of total) and the
// findings that match none (fpFindings), the cases evals/stage-signals.js
// reads for the panel.
function finderResult(raw) {
    if (!raw || !Array.isArray(raw.rows) || !raw.rows.length) return null;
    // eslint-disable-next-line global-require
    const { finderCases } = require('./stage-signals');
    return {
        eval: 'finder-recall',
        metric: { name: 'of known bugs shipped', value: raw.metrics?.recall_mean ?? null },
        cases: finderCases(raw.rows),
        metrics: raw.metrics || {},
        tokens: raw.usage || null,
        environment: { judge: raw.judge ?? null },
        teamConfig: raw.teamConfig ?? null,
    };
}

// The evals an experiment on a step runs: the one that answers whether the
// change is better, and the ones that must not get worse. `smoke`: the wiring
// smoke steps that load the step's production path; a PR that changes one of
// the files they load runs the experiment (`--affected`). Per eval: `read`
// turns its own result into the shared shape, `sets` is the folder of its sets
// of its own (--set), and `teamConfig` says it takes --team-config.
const STEP_EVALS = {
    dedup: {
        smoke: ['funnel-dedup'],
        primary: {
            id: 'dedup-groups',
            label: 'Duplicate pairs joined',
            run: ['evals/dedup-groups/run.js'],
            question: 'Does the dedup join the suggestions that report the same problem, and only those?',
            // Read from the same cases: joining everything would score every pair, so
            // what it merged must stay right too. Not worse beyond its interval.
            derived: [{ id: 'pair-precision', label: 'Merges that were right', question: 'Of the pairs the dedup merged, how many does the gold put in one group?', hits: (c) => c.merged - c.falseMerges, total: (c) => c.merged }],
        },
        guards: [{ id: 'funnel-dedup', label: 'Known bugs kept', run: ['evals/funnel/dedup/run.js', '--set=full'], question: 'Of the known bugs reaching the dedup in a real review, how many does it keep?' }],
    },
    severity: {
        // On demand only, never a PR's check: its files include the review stage,
        // which nearly every engine change touches.
        smoke: [],
        primary: {
            id: 'severity-levels',
            label: 'Suggestions at their level',
            run: ['evals/severity-levels/run.js'],
            question: 'Does the severity step rate each suggestion at the level its text defines?',
        },
        guards: [{ id: 'funnel-severity', label: 'Known bugs kept', run: ['evals/funnel/severity/run.js', '--set=full'], question: 'Of the known bugs reaching the severity step in a real review, how many does it keep above the threshold?' }],
    },
    finder: {
        // On demand only, never a PR's check: every case is a full review, so the
        // controlled set at 2 runs is 60 reviews, and nearly every engine change
        // loads the finder.
        smoke: [],
        primary: {
            id: 'finder-recall',
            label: 'Known bugs shipped',
            run: ['evals/investigation/run-recall.js', '--concurrency=6'],
            question: 'Of the known bugs in a PR, how many does the review ship?',
            read: finderResult,
            sets: 'evals/investigation/sets',
            teamConfig: true,
            // Read from the same cases: shipping more of everything would find more
            // bugs, so what it ships must stay right too. Not worse beyond its
            // interval. A real bug the dataset does not list counts against it.
            derived: [{ id: 'finder-precision', label: 'Comments that were known bugs', question: 'Of the comments the review shipped, how many match a known bug?', hits: (c) => c.hits, total: (c) => (Number.isInteger(c.fpFindings) ? c.hits + c.fpFindings : NaN) }],
        },
        guards: [],
    },
};

// The two questions an experiment answers, in order.
const PHASES = {
    regression: { set: 'controlled', question: 'Did it break anything?', guards: true },
    decision: { set: 'full', question: 'Is it better?', guards: false },
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

// A measure read from the main eval's own cases (`derived`): each run's cases
// with that measure's hits and total, so it compares like any eval.
function deriveRuns(runs, derived) {
    return runs.map((run) =>
        run
            ? { ...run, cases: (run.cases || []).filter((c) => !c.unmeasured && Number.isFinite(derived.total(c))).map((c) => ({ id: c.id, checks: derived.question, hits: derived.hits(c), total: derived.total(c) })) }
            : null,
    );
}

// Every requested run on both sides, or 'not measured': comparing fewer runs
// than the experiment reports would overstate it. A missing run is null.
function comparisonOf(baseRuns, candidateRuns) {
    const comparison = compare(baseRuns.filter(Boolean), candidateRuns.filter(Boolean));
    const missing = { base: baseRuns.filter((x) => !x).length, candidate: candidateRuns.filter((x) => !x).length };
    return missing.base || missing.candidate ? { ...comparison, verdict: 'not measured', missingRuns: missing } : comparison;
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
    const data = evalFiles.filter((f) => /\/(cases|datasets|snapshot|sets)\/|cases\.json$/.test(f));
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

function runEval(entry, { side, dir, model, out, round, trace, extra = [] }) {
    const output = path.join(out, side, `${entry.id}.r${round}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const traceDir = path.join(trace, `${side}-${entry.id}-r${round}`);
    const log = fs.openSync(path.join(out, side, `${entry.id}.r${round}.log`), 'w');
    console.log(`  ${side.padEnd(9)} ${entry.id} run ${round}`);
    const r = spawnSync(process.execPath, [...entry.run, ...extra, `--model=${model}`, `--output=${output}`], {
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
    const raw = readJson(output);
    return { result: raw && entry.read ? entry.read(raw) : raw, exit: r.status ?? 2, traceDir };
}

// A phase's answer: regression → 'no regression' | 'regression'; decision →
// the main eval's verdict ('better' | 'tie' | 'worse'). 'not measured' when an
// eval did not measure on both sides.
function phaseVerdict(phase, evals) {
    if (evals.some((e) => e.comparison.verdict === 'not measured')) return 'not measured';
    const [primary, ...guards] = evals;
    if (phase === 'decision') return primary.comparison.verdict;
    // A guard eval may not lose a single case; a measure read from the main
    // eval's cases (rule 'interval') may not get worse beyond its interval.
    const guardWorse = (g) => g.comparison.verdict === 'worse' || (g.rule !== 'interval' && g.comparison.worse.length > 0);
    const worse = primary.comparison.verdict === 'worse' || guards.some(guardWorse);
    return worse ? 'regression' : 'no regression';
}

// `sameCode`: a --team-config experiment runs one commit on both sides, so an
// unchanged step is the point, not a reason to stop. `worse`: something got
// worse (not merely "not better"), which a decision over several models vetoes.
function decide(phases, versions, { sameCode = false } = {}) {
    if (!sameCode && versions.base.step === versions.candidate.step) return { decision: 'no change in this step', reason: 'the branch did not change a production file this step loads', worse: false };
    if (Object.values(phases).some((p) => p.verdict === 'not measured')) return { decision: 'not measured', reason: 'an eval did not measure on both sides', worse: false };
    const reg = phases.regression;
    if (reg && reg.verdict === 'regression') {
        const which = reg.evals.filter((e) => e.comparison.verdict === 'worse' || (e.role === 'guard' && e.rule !== 'interval' && e.comparison.worse.length));
        return { decision: 'does not ship', reason: `it broke something: ${which.map((e) => `${e.id}${e.comparison.worse.length ? ` (${e.comparison.worse.length} case${e.comparison.worse.length === 1 ? '' : 's'} worse)` : ''}`).join(', ')}`, worse: true };
    }
    const dec = phases.decision;
    if (!dec) return { decision: 'no regression', reason: 'nothing got worse on the controlled set; the decision phase, on the extended set, decides an improvement', worse: false };
    const primary = dec.evals[0];
    const onSet = !dec.set || dec.set === 'full' ? 'on the extended set' : `on the set ${dec.set}`;
    const decWorse = dec.evals.filter((e) => e.role === 'guard' && e.comparison.verdict === 'worse');
    if (decWorse.length) return { decision: 'does not ship', reason: `${onSet}, ${decWorse.map((e) => e.id).join(', ')} got worse beyond its interval`, worse: true };
    if (dec.verdict === 'better') return { decision: 'ships', reason: `nothing got worse, and ${primary.id} is better ${onSet} beyond its interval`, worse: false };
    const tokens = (side) => (primary.sides[side].usage.in || 0) + (primary.sides[side].usage.out || 0);
    if (dec.verdict === 'tie' && tokens('candidate') < tokens('base')) return { decision: 'ships', reason: `nothing got worse, ${primary.id} ties and the candidate uses fewer tokens`, worse: false };
    return { decision: 'does not ship', reason: dec.verdict === 'worse' ? `${primary.id} is worse ${onSet} beyond its interval` : `${primary.id} is not better ${onSet}, and the candidate is not cheaper`, worse: dec.verdict === 'worse' };
}

// The experiment in one table per phase, for a job summary or a PR.
function summaryMarkdown(x, { pct, pp }) {
    const sides = x.teamConfig
        ? `${x.branch} \`${x.candidate.sha.slice(0, 9)}\`, without the team config against with it (\`${x.teamConfig.hash}\`: ${Object.keys(x.teamConfig.configs).map((k) => `\`${k}\``).join(', ')})`
        : `${x.branch} \`${x.candidate.sha.slice(0, 9)}\` against where it left ${x.baseRef} \`${x.base.sha.slice(0, 9)}\``;
    const reused = x.exits.filter((e) => e.reused).length;
    const lines = [
        `### Experiment: ${x.step} · ${x.name}`,
        '',
        `${sides} · ${x.model} · ${x.runs} runs each side${reused ? ` (${reused} base-side runs reused from an earlier experiment on the same base code)` : ''}`,
        '',
        `**${x.decision.decision}**: ${x.decision.reason}`,
        '',
        `Step version \`${x.base.version.step}\` → \`${x.candidate.version.step}\`${x.changedFiles.length ? ` (${x.changedFiles.map((f) => `\`${f}\``).join(', ')})` : ', the same'}`,
    ];
    for (const [phase, p] of Object.entries(x.phases)) {
        lines.push('', `**${PHASES[phase].question}** (${p.set} set): ${p.verdict}`, '', '| Eval | Base | Candidate | Difference (95%) | Verdict | Worse / better cases |', '|---|---|---|---|---|---|');
        for (const e of p.evals) {
            const c = e.comparison;
            lines.push(`| ${e.role === 'primary' ? `**${e.id}**` : e.id} | ${pct(c.base)} | ${pct(c.candidate)} | ${pp(c.diff)} pp [${pp(c.ci?.[0])}, ${pp(c.ci?.[1])}] | ${c.verdict} | ${c.worse.length} / ${c.better.length} |`);
        }
    }
    return `${lines.join('\n')}\n`;
}

// The steps a change touched: those whose wiring smoke steps loaded a changed
// production file (the smoke's per-step lists, --eval-files-dir).
function affectedSteps(changed, filesOf, steps = STEP_EVALS) {
    const prod = new Set(changed.filter((f) => /^(libs|apps|packages)\//.test(f)));
    return Object.entries(steps)
        .filter(([, plan]) => (plan.smoke || []).some((name) => filesOf(name).some((f) => prod.has(f))))
        .map(([step]) => step);
}

// The content (git blob ids) of `files` at `sha`.
function blobsAt(sha, files) {
    if (!files.length) return {};
    const out = git(['ls-tree', '-r', sha, '--', ...files]);
    return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => { const [meta, file] = l.split('\t'); return [file, meta.split(' ')[2]]; }));
}

// A recorded experiment that measured exactly this, so it need not run again:
// the same model, runs, evals (their tree), decision set (a private one by its
// content), team config and review environment (reviewEnv),
// every phase asked for answered (none missing or not measured), and the same
// content of every step file it recorded on both sides. A record without any of
// these is not reused. `reuse` is what the run recorded for this (the panel
// passes it back as written); a record from before it measured the extended
// set with no team config.
function measuredAlready(recorded, { phaseIds, model, runs, evalsTree, set = 'full', teamConfigHash = null, env = envHashOf({}) }, blobsOf) {
    return (recorded || []).find((x) => {
        const blobs = x.step_blobs;
        if (!blobs || !blobs.base || !blobs.candidate || !Object.keys(blobs.candidate).length) return false;
        const r = x.reuse && typeof x.reuse === 'object' ? x.reuse : { model: x.model, runs: x.runs, evals_tree: x.evals_tree, set: 'full', team_config_hash: null };
        if (r.model !== model || r.runs !== runs || !r.evals_tree || r.evals_tree !== evalsTree) return false;
        if ((r.set ?? 'full') !== set || (r.team_config_hash ?? null) !== teamConfigHash || (r.env ?? envHashOf({})) !== env) return false;
        const verdicts = x.phase_verdicts || {};
        if (!phaseIds.every((p) => (x.phases || []).includes(p) && verdicts[p] && verdicts[p] !== 'not measured')) return false;
        const same = (want, side) => {
            const have = blobsOf(side, Object.keys(want));
            return Object.entries(want).every(([file, blob]) => have[file] === blob);
        };
        return same(blobs.base, 'base') && same(blobs.candidate, 'candidate');
    }) || null;
}

// One run, one name: the branch (or --name), the candidate commit, when the run
// started (UTC, to the second) and a random suffix, taken once for all its rows.
// A later run writes rows of its own instead of overwriting some of this run's
// and leaving the rest, even at the same commit and second (a regression-only
// check on another model after a full run would otherwise mix two runs in one
// experiment).
const runName = (branchOrName, head, startedAt, nonce = crypto.randomBytes(3).toString('hex')) =>
    `${slug(branchOrName)}-${String(head).slice(0, 9)}-${startedAt.toISOString().replace(/\D/g, '').slice(0, 14)}-${nonce}`;

// The folders' JSON files, by name and content: what a private set is recorded by.
const jsonFiles = (dir) => (fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);
const dirHash = (dir) => hash(jsonFiles(dir).map((f) => `${f}:${crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, f))).digest('hex')}`));

// The cases "is it better?" runs on (--set): the extended set; a set of the
// step's own, a folder of its main eval's `sets`; or a private set, an
// absolute path outside this public repository, recorded by its content.
function setOf(plan, value) {
    const v = value === undefined || value === true ? 'full' : String(value);
    if (v === 'full') return { id: 'full', args: ['--set=full'] };
    if (v === 'controlled') throw new Error('--set=controlled is the regression phase\'s own set: --set names the cases "is it better?" runs on');
    if (!plan.primary.sets) throw new Error(`${plan.primary.id} has no sets of its own: --set=full only`);
    if (path.isAbsolute(v)) {
        if (!jsonFiles(v).length) throw new Error(`--set=${v}: no case files in that folder`);
        return { id: `private:${slug(path.basename(v))}`, args: [`--set=${v}`], private: true, hash: dirHash(v) };
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(v)) throw new Error(`--set=${v}: a folder of ${plan.primary.sets}/, or the absolute path of a private set`);
    if (!jsonFiles(path.join(ROOT, plan.primary.sets, v)).length) throw new Error(`no set '${v}' in ${plan.primary.sets}/ (a folder of its cases, on the base ref first)`);
    return { id: v, args: [`--set=${v}`] };
}

// The base side's runs, kept so the next experiment on the same base code does
// not pay for them again: the same eval, arguments, model, round, evals and
// lockfile, and the same content of every production file the run loaded. At
// most BASE_REUSE_DAYS old: a provider drifts, and a reused run was not
// measured beside the candidate's.
const BASE_REUSE_DAYS = 7;
const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'kodus-evals', 'experiment-base');
// What a run reads from the environment besides its arguments and changes what
// it measures (the finder's categories and reasoning effort, the judge and its
// effort): part of what a base run, and a recorded experiment, measured. Never
// keys, tokens or URLs.
const reviewEnv = (env = process.env) =>
    Object.fromEntries(
        Object.entries(env)
            .filter(([k]) => /^(RECALL_|JUDGE_|FINDER_)/.test(k) && !/(KEY|TOKEN|SECRET|URL|DUMP)$/.test(k))
            .sort(([a], [b]) => a.localeCompare(b)),
    );
const envHashOf = (env) => hash(Object.entries(env).map(([k, v]) => `${k}=${v}`));
// A set as a reuse must match it: a private one by its content too.
const setIdentity = (set) => (set.private ? `${set.id}@${set.hash}` : set.id);
const baseCacheFile = (dir, parts) => path.join(dir, `${crypto.createHash('sha1').update(canonical(parts)).digest('hex')}.json`);

function reusableBase(dir, parts, blobsOf, now = Date.now()) {
    const rec = readJson(baseCacheFile(dir, parts));
    if (!rec || !rec.result || !rec.savedAt || now - Date.parse(rec.savedAt) > BASE_REUSE_DAYS * 86_400_000) return null;
    const files = Object.keys(rec.prodBlobs || {});
    if (!files.length) return null;
    const have = blobsOf(files);
    return files.every((f) => have[f] === rec.prodBlobs[f]) ? rec : null;
}

function keepBase(dir, parts, rec) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(baseCacheFile(dir, parts), JSON.stringify(rec));
    } catch (error) {
        console.warn(`  base run not kept for reuse: ${error.message}`);
    }
}

// Whether a model's experiment found something worse: what its decision says
// (decide), or, for a record from before it said so, what its verdicts show
// (a regression, a worse main eval, or "better" that did not ship: a guard).
function modelWorse(decision, verdicts = {}) {
    if (typeof decision.worse === 'boolean') return decision.worse;
    return verdicts.regression === 'regression' || verdicts.decision === 'worse' || (verdicts.decision === 'better' && decision.decision === 'does not ship');
}

// One decision over several models (--models). Each customer runs one model,
// so a loss on any of them ships to its customers: it ships when no model got
// worse and one is better (or every one ties and is cheaper).
function decideAcrossModels(perModel) {
    const named = (list) => list.map((m) => m.model).join(', ');
    const verdicts = (m) => m.verdicts || {};
    const notMeasured = perModel.filter((m) => m.decision.decision === 'not measured' || Object.values(verdicts(m)).includes('not measured'));
    if (notMeasured.length) return { decision: 'not measured', reason: `not measured on ${named(notMeasured)}` };
    if (perModel.every((m) => m.decision.decision === 'no change in this step')) return { decision: 'no change in this step', reason: 'the branch did not change a production file this step loads' };
    const worse = perModel.filter((m) => modelWorse(m.decision, verdicts(m)));
    if (worse.length) return { decision: 'does not ship', reason: `worse on ${named(worse)}` };
    if (perModel.every((m) => !verdicts(m).decision)) return { decision: 'no regression', reason: `nothing got worse on ${named(perModel)}; the decision phase decides an improvement` };
    const better = perModel.filter((m) => verdicts(m).decision === 'better');
    const rest = perModel.filter((m) => !better.includes(m));
    if (better.length) return { decision: 'ships', reason: `better on ${named(better)}${rest.length ? `, no worse on ${named(rest)}` : ''}` };
    if (perModel.every((m) => m.decision.decision === 'ships')) return { decision: 'ships', reason: 'ties on every model, and each uses fewer tokens' };
    return { decision: 'does not ship', reason: 'better on no model' };
}

// What a run that was not repeated says (--if-new): the panel's record, quoted as data.
function reusedSummary(step, name, hit, phaseIds) {
    const verdicts = hit.phase_verdicts || {};
    // One line each, so it cannot close the quote.
    const quoted = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/[<>`]/g, '');
    return [
        `### Experiment: ${step} · ${name}`,
        '',
        `This code was measured already, on ${String(hit.ts).slice(0, 10)}, with the same model, runs, evals, set and team config and the same content in every file of the step: not run again. The panel's record, as data:`,
        '',
        `> decision: ${quoted(hit.decision)}`,
        `> reason: ${quoted(hit.reason)}`,
        ...phaseIds.map((p) => `> ${quoted(PHASES[p].question)} ${quoted(verdicts[p])}`),
        '',
        experimentsPage(),
        '',
    ].join('\n');
}

const STATUS = { better: 'green', tie: 'yellow', worse: 'red', 'not measured': 'infra' };
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');
const pp = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}` : 'n/a');

// One model's experiment: every phase's evals on both sides, compared, recorded
// and sent to the panel.
async function measureModel(ctx) {
    const { step, plan, phaseIds, runs, set, team, head, branch, baseSha, baseRef, baseDir, model, name, out } = ctx;
    const trace = path.join(out, 'trace');
    fs.mkdirSync(out, { recursive: true });
    console.log(`experiment ${step} · ${name}: ${team ? `${head.slice(0, 9)} without the team config against with it (${team.hash})` : `base ${baseSha.slice(0, 9)} (${baseRef}) vs candidate ${head.slice(0, 9)} (${branch})`} · ${model} · ${phaseIds.join(' + ')} · ${runs} runs each · ${out}`);

    const traces = { base: new Set(), candidate: new Set() };
    const exits = [];
    const measured = {};
    for (const phase of phaseIds) {
        const def = PHASES[phase];
        const phaseSet = phase === 'decision' ? set : { id: def.set, args: [`--set=${def.set}`] };
        const entries = [{ ...plan.primary, role: 'primary', run: [...plan.primary.run, ...phaseSet.args] }, ...(def.guards ? plan.guards.map((g) => ({ ...g, role: 'guard' })) : [])];
        const results = Object.fromEntries(entries.map((e) => [e.id, { base: [], candidate: [] }]));
        console.log(`${def.question} (${phase}, ${phaseSet.id} set)`);
        for (let round = 1; round <= runs; round++) {
            for (const side of ['base', 'candidate']) {
                for (const entry of entries) {
                    const extra = side === 'candidate' && team ? [`--team-config=${team.file}`] : [];
                    const parts = { eval: entry.id, args: [...entry.run, ...extra], model, round, evals: ctx.evalsTree, lock: ctx.lockBlob, set: set.private ? set.hash : null, env: reviewEnv() };
                    const kept = side === 'base' && !ctx.freshBase ? reusableBase(ctx.cacheDir, parts, (files) => blobsAt(baseSha, files)) : null;
                    if (kept) {
                        console.log(`  ${side.padEnd(9)} ${entry.id} run ${round}: reused from ${kept.savedAt}`);
                        exits.push({ phase, side, eval: entry.id, round, exit: 0, reused: kept.savedAt });
                        results[entry.id][side].push(kept.result);
                        for (const f of kept.traced || []) traces[side].add(f);
                        continue;
                    }
                    const r = runEval(entry, { side, dir: side === 'base' ? baseDir : ROOT, model, out: path.join(out, phase), round, trace: path.join(trace, phase), extra });
                    let result = r.result && r.exit !== 2 ? r.result : null;
                    // The team config each side ran is what its eval reports, never assumed.
                    const want = side === 'candidate' && team ? team.hash : null;
                    if (result && entry.teamConfig && (result.teamConfig?.hash ?? null) !== want) {
                        console.warn(`  ${side} ${entry.id} run ${round}: ran team config ${result.teamConfig?.hash ?? 'none'}, not ${want ?? 'none'}: not measured`);
                        result = null;
                    }
                    exits.push({ phase, side, eval: entry.id, round, exit: r.exit });
                    results[entry.id][side].push(result);
                    const traced = readTraces(r.traceDir);
                    for (const f of traced) traces[side].add(f);
                    if (side === 'base' && result) {
                        const prodFiles = [...traced].filter((f) => /^(libs|apps|packages)\//.test(f));
                        keepBase(ctx.cacheDir, parts, { savedAt: new Date().toISOString(), baseSha, traced: [...traced], prodBlobs: blobsAt(baseSha, prodFiles), result });
                    }
                }
            }
        }
        measured[phase] = { entries, results, set: phaseSet };
    }

    const versions = { base: versionOf(baseSha, traces.base), candidate: versionOf(head, traces.candidate) };
    const allProd = [...new Set([...versions.base.prodBlobs.keys(), ...versions.candidate.prodBlobs.keys()])];
    const changedFiles = allProd.filter((f) => versions.base.prodBlobs.get(f) !== versions.candidate.prodBlobs.get(f)).sort();
    // The production files the step loads, with their content on each side
    // (git blob ids): a file that later differs on main from the base, or on
    // the branch from the candidate, dates this result.
    const stepBlobs = {
        base: Object.fromEntries([...versions.base.prodBlobs].sort()),
        candidate: Object.fromEntries([...versions.candidate.prodBlobs].sort()),
    };
    const phases = Object.fromEntries(
        Object.entries(measured).map(([phase, { entries, results, set: phaseSet }]) => {
            const evals = entries.map((entry) => {
                const r = results[entry.id];
                return {
                    id: entry.id,
                    label: entry.label,
                    role: entry.role,
                    question: entry.question,
                    metric: (r.candidate.find(Boolean) || r.base.find(Boolean) || {}).metric?.name || null,
                    comparison: comparisonOf(r.base, r.candidate),
                    sides: { base: sideSummary(r.base), candidate: sideSummary(r.candidate) },
                    runValues: { base: r.base.map((x) => x?.metric?.value ?? null), candidate: r.candidate.map((x) => x?.metric?.value ?? null) },
                    baseReused: exits.filter((e) => e.phase === phase && e.eval === entry.id && e.reused).length,
                };
            });
            const primaryRuns = results[plan.primary.id];
            for (const d of plan.primary.derived || []) {
                const base = deriveRuns(primaryRuns.base, d);
                const candidate = deriveRuns(primaryRuns.candidate, d);
                evals.splice(1, 0, {
                    id: d.id,
                    label: d.label,
                    role: 'guard',
                    rule: 'interval',
                    question: d.question,
                    metric: d.question,
                    comparison: comparisonOf(base, candidate),
                    sides: evals[0].sides,
                    runValues: {
                        base: base.map((r) => (r ? compare([r], [r]).base : null)),
                        candidate: candidate.map((r) => (r ? compare([r], [r]).base : null)),
                    },
                    baseReused: evals[0].baseReused,
                });
            }
            return [phase, { question: PHASES[phase].question, set: phaseSet.id, verdict: phaseVerdict(phase, evals), evals }];
        }),
    );
    const decision = decide(phases, versions, { sameCode: Boolean(team) });
    const strip = ({ prodBlobs: _blobs, ...v }) => v;
    const experiment = {
        step,
        name,
        group: ctx.group,
        models: ctx.models,
        branch,
        baseRef,
        model,
        runs,
        set: { id: set.id, private: Boolean(set.private), hash: set.hash || null },
        teamConfig: team ? { hash: team.hash, configs: team.configs } : null,
        createdAt: new Date().toISOString(),
        base: { sha: baseSha, version: strip(versions.base) },
        candidate: { sha: head, version: strip(versions.candidate) },
        changedFiles,
        stepBlobs,
        evalsTree: ctx.evalsTree,
        phases,
        decision,
        exits,
    };
    fs.writeFileSync(path.join(out, 'experiment.json'), `${JSON.stringify(experiment, null, 2)}\n`);
    const reuse = { model, runs, evals_tree: ctx.evalsTree, set: setIdentity(set), team_config_hash: team ? team.hash : null, env: envHashOf(reviewEnv()), worse: decision.worse };
    const rows = Object.entries(phases).flatMap(([phase, p]) =>
        p.evals.map((e) => ({
            name: `experiments.${slug(step)}.${phase}.${slug(e.id)}.${name}`,
            status: STATUS[e.comparison.verdict] || 'infra',
            value: e.comparison.diff,
            unit: 'ratio',
            meta: {
                stage: step,
                experiment: name,
                // the run this belongs to: one per model with --models
                group: ctx.group,
                models: ctx.models,
                kind: team ? 'team-config' : 'code',
                branch,
                phase,
                phase_question: p.question,
                phase_verdict: p.verdict,
                phases: Object.keys(phases),
                eval: e.id,
                label: e.label,
                role: e.role,
                rule: e.rule || null,
                question: e.question,
                metric: e.metric,
                model,
                runs,
                set: p.set,
                set_private: phase === 'decision' && Boolean(set.private),
                team_config: experiment.teamConfig,
                base: { sha: baseSha, ref: baseRef, step_version: versions.base.step },
                candidate: { sha: head, step_version: versions.candidate.step },
                eval_version: versions.candidate.eval,
                // the evals' whole tree: the same on both sides (checked above), what a reuse must match
                evals_tree: ctx.evalsTree,
                dataset_version: phase === 'decision' && set.private ? set.hash : versions.candidate.dataset,
                // what --if-new matches besides the code, passed back by the panel as written
                reuse,
                changed_files: changedFiles,
                // once per phase, on its main eval's row
                ...(e.role === 'primary' ? { step_blobs: stepBlobs } : {}),
                comparison: { ...e.comparison, worse: e.comparison.worse.slice(0, 20), better: e.comparison.better.slice(0, 20), worseCount: e.comparison.worse.length, betterCount: e.comparison.better.length },
                sides: e.sides,
                run_values: e.runValues,
                base_reused: e.baseReused,
                decision: decision.decision,
                decision_reason: decision.reason,
                // the CI run, when there is one (GitHub's own variables)
                ...(process.env.GITHUB_RUN_ID ? { run_url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` } : {}),
            },
        })),
    );
    fs.writeFileSync(path.join(out, 'rows.json'), `${JSON.stringify(rows, null, 2)}\n`);
    const summary = summaryMarkdown(experiment, { pct, pp });
    fs.writeFileSync(path.join(out, 'summary.md'), summary);
    console.log(`\nstep version: base ${versions.base.step}, candidate ${versions.candidate.step}${changedFiles.length ? ` (${changedFiles.length} files changed: ${changedFiles.slice(0, 4).join(', ')}${changedFiles.length > 4 ? ', …' : ''})` : ' — the same'}`);
    for (const [phase, p] of Object.entries(phases)) {
        console.log(`${p.question} (${phase}, ${p.set} set): ${p.verdict}`);
        for (const e of p.evals) {
            const c = e.comparison;
            console.log(`  ${e.role === 'primary' ? '★' : '·'} ${e.id}: base ${pct(c.base)} → candidate ${pct(c.candidate)}, ${pp(c.diff)} pp [${pp(c.ci?.[0])}, ${pp(c.ci?.[1])}] over ${c.cases} cases · ${c.verdict} · ${c.worse.length} worse, ${c.better.length} better · runs base ${e.runValues.base.map(pct).join('/')} candidate ${e.runValues.candidate.map(pct).join('/')}`);
        }
    }
    console.log(`\ndecision: ${decision.decision} — ${decision.reason}\n${path.join(out, 'experiment.json')}`);
    const sent = await sendExperimentRows(rows);
    console.log(sent.sent ? `sent to the quality panel: ${sent.url}` : `not sent to the quality panel: ${sent.reason}`);
    return { model, name, verdicts: Object.fromEntries(Object.entries(phases).map(([id, p]) => [id, p.verdict])), decision, summary };
}

// Each model measured on its own: one that fails is recorded as not measured,
// and the others still count.
async function measureEach(models, measure, { step, nameOf }) {
    const done = [];
    for (const model of models) {
        try {
            done.push(await measure(model));
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.error(`experiment ${step} on ${model} (${nameOf(model)}): not measured: ${error instanceof Error ? error.stack : reason}`);
            done.push({ model, name: nameOf(model), verdicts: {}, decision: { decision: 'not measured', reason: `${model}: ${reason}`, worse: false }, summary: `### Experiment: ${step} · ${nameOf(model)}\n\nNot measured on ${model}: ${reason}\n` });
        }
    }
    return done;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.affected) {
        // A missing list means the impact is unknown, never that nothing changed.
        const lines = (file) => {
            if (!file || !fs.existsSync(file)) throw new Error(`cannot tell which steps changed: ${file || 'no file given'} is missing`);
            return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
        };
        try {
            const changed = lines(args.changed && String(args.changed));
            const dir = String(args['files-dir'] || '');
            console.log(JSON.stringify(affectedSteps(changed, (name) => lines(dir && path.join(dir, `${name}.txt`)))));
            return 0;
        } catch (error) {
            console.error(error.message);
            return 2;
        }
    }
    const step = args.step;
    const plan = STEP_EVALS[step];
    if (!plan) {
        console.error(`usage: experiment.js --step=<${Object.keys(STEP_EVALS).join('|')}> [--base=origin/main] [--runs=2] [--model=<id> | --models=<id>,<id>] [--set=<name>] [--team-config=<file>] [--name=<label>] [--out=<dir>]`);
        return 2;
    }
    if (args.model !== undefined && args.models !== undefined) {
        console.error('--model or --models, not both');
        return 2;
    }
    const models = [...new Set(String(args.models ?? args.model ?? DEFAULT_MODEL).split(',').map((m) => m.trim()).filter(Boolean))];
    const unknownModel = models.find((m) => !TIER0[m]);
    if (!models.length || unknownModel) {
        console.error(`unknown model ${unknownModel ?? '(none)'}: a model of evals/shared/tier0-models.js`);
        return 2;
    }
    const asked = args.runs === undefined ? DEFAULT_RUNS : Number(args.runs);
    const runs = Number.isInteger(asked) && asked >= 1 && asked <= MAX_RUNS ? asked : DEFAULT_RUNS;
    if (runs !== asked) console.warn(`--runs=${args.runs} is not a whole number from 1 to ${MAX_RUNS}: running ${DEFAULT_RUNS} per side`);
    const phaseIds = args.phases ? String(args.phases).split(',') : Object.keys(PHASES);
    const unknownPhase = phaseIds.find((p) => !PHASES[p]);
    if (unknownPhase || !phaseIds.length) {
        console.error(`unknown --phases=${args.phases}: ${Object.keys(PHASES).join(', ')}`);
        return 2;
    }
    // "Is it better?" means nothing until "did it break anything?" says no.
    if (!phaseIds.includes('regression')) {
        console.error('--phases needs regression: the decision phase runs only after it');
        return 2;
    }
    let set;
    let team = null;
    try {
        set = setOf(plan, args.set);
        if (args['team-config'] !== undefined) team = readTeamConfig(String(args['team-config']));
    } catch (error) {
        console.error(`experiment --step=${step} (models ${models.join(', ')}): ${error instanceof Error ? error.message : String(error)}`);
        return 2;
    }
    if (team) {
        const cannot = [plan.primary, ...plan.guards].filter((e) => !e.teamConfig).map((e) => e.id);
        if (cannot.length) {
            console.error(`--team-config: ${cannot.join(', ')} does not take a team config`);
            return 2;
        }
    }
    // What ran must be a commit: uncommitted changes would make the result point at code that does not exist.
    const dirty = git(['status', '--porcelain', '--untracked-files=no']);
    if (dirty) {
        console.error(`commit first: the candidate is HEAD, and these changes are not in it:\n${dirty}`);
        return 2;
    }
    const head = git(['rev-parse', 'HEAD']);
    // A PR's check runs on the head commit, detached: GitHub names the branch.
    const branch = process.env.GITHUB_HEAD_REF || git(['rev-parse', '--abbrev-ref', 'HEAD']);
    // A team-config experiment runs HEAD on both sides; a code one, HEAD against where it left its base ref.
    const baseRef = team ? 'HEAD' : args.base || 'origin/main';
    let baseSha = head;
    if (!team) {
        baseSha = git(['merge-base', head, baseRef]);
        if (baseSha === head) {
            console.error(`nothing to compare: HEAD is where it left ${baseRef}`);
            return 2;
        }
        const evalDiff = git(['diff', '--name-only', baseSha, head, '--', 'evals']);
        if (evalDiff) {
            console.error(`not comparable: the evals differ between the two sides; land the eval change on ${baseRef} first:\n${evalDiff}`);
            return 2;
        }
    }
    const evalsTree = git(['rev-parse', `${head}:evals`]);
    const group = runName(args.name || branch, head, new Date());
    const out = path.resolve(args.out || path.join(os.tmpdir(), 'kodus-experiments', `${step}-${group}`));
    fs.mkdirSync(out, { recursive: true });
    let lockBlob = null;
    try {
        lockBlob = git(['rev-parse', `${baseSha}:pnpm-lock.yaml`]);
    } catch {
        /* no lockfile at the base: the key says so */
    }
    const ctx = {
        step,
        plan,
        phaseIds,
        runs,
        set,
        team,
        head,
        branch,
        baseSha,
        baseRef,
        evalsTree,
        group,
        models,
        lockBlob,
        cacheDir: path.resolve(String(args['cache-dir'] || DEFAULT_CACHE_DIR)),
        freshBase: Boolean(args['fresh-base']),
    };

    // With --if-new, a model whose experiment the panel already has is not run again.
    const recorded = args['if-new'] ? await recordedExperiments(step, branch) : null;
    const perModel = [];
    const pending = [];
    for (const model of models) {
        const identity = { phaseIds, model, runs, evalsTree, set: setIdentity(set), teamConfigHash: team ? team.hash : null, env: envHashOf(reviewEnv()) };
        const hit = recorded && measuredAlready(recorded, identity, (side, files) => blobsAt(side === 'base' ? baseSha : head, files));
        if (hit) {
            console.log(`${model}: measured already on ${hit.ts}: ${hit.decision} — ${hit.reason}`);
            perModel.push({ model, name: hit.experiment, verdicts: hit.phase_verdicts || {}, decision: { decision: hit.decision, reason: hit.reason, worse: hit.reuse?.worse }, summary: reusedSummary(step, hit.experiment, hit, phaseIds) });
        } else {
            if (args['if-new']) console.log(`${model}: ${recorded === null ? 'the panel could not say whether this code was measured' : 'not measured yet'}: running it`);
            pending.push(model);
        }
    }

    // The base checkout is set up inside the same cleanup as the runs: a setup
    // that fails halfway leaves no folder behind.
    let baseDir = ROOT;
    try {
        if (pending.length && !team) {
            baseDir = path.join(out, 'base-tree');
            git(['worktree', 'add', '--detach', baseDir, baseSha]);
            fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(baseDir, 'node_modules'));
            // The EE config is gitignored; production code reads it at import time.
            // So are the local .env files the evals load (agent-provider.js): both sides get the same keys.
            for (const file of ['libs/ee/configs/environment/environment.ts', '.env', '.env.local']) {
                if (fs.existsSync(path.join(ROOT, file))) fs.copyFileSync(path.join(ROOT, file), path.join(baseDir, file));
            }
        }
        const nameOf = (model) => (models.length > 1 ? `${group}-${slug(model)}` : group);
        perModel.push(...(await measureEach(pending, (model) => measureModel({ ...ctx, model, name: nameOf(model), baseDir, out: models.length > 1 ? path.join(out, slug(model)) : out }), { step, nameOf })));
    } finally {
        if (baseDir !== ROOT) {
            try {
                git(['worktree', 'remove', '--force', baseDir]);
            } catch {
                /* left for `git worktree prune` */
            }
        }
    }
    perModel.sort((a, b) => models.indexOf(a.model) - models.indexOf(b.model));

    let summary = perModel.map((m) => m.summary).join('\n');
    if (models.length > 1) {
        const across = decideAcrossModels(perModel);
        summary = [`### Experiment: ${step} · ${group} · ${models.length} models`, '', `**${across.decision}**: ${across.reason}`, '', ...perModel.map((m) => `- ${m.model}: ${m.decision.decision} (${m.decision.reason})`), '', summary].join('\n');
        console.log(`\nacross ${models.length} models: ${across.decision} — ${across.reason}`);
        const status = { ships: 'green', 'does not ship': 'red', 'not measured': 'infra' }[across.decision] || 'yellow';
        const sent = await sendExperimentRows([
            {
                name: `experiments.${slug(step)}.group.${group}`,
                status,
                value: null,
                unit: 'ratio',
                meta: {
                    stage: step,
                    experiment: group,
                    kind: 'group',
                    group,
                    branch,
                    models,
                    decision: across.decision,
                    decision_reason: across.reason,
                    per_model: perModel.map((m) => ({ model: m.model, experiment: m.name, decision: m.decision.decision })),
                    ...(process.env.GITHUB_RUN_ID ? { run_url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` } : {}),
                },
            },
        ]);
        if (!sent.sent) console.log(`the decision across models was not sent to the quality panel: ${sent.reason}`);
    }
    fs.writeFileSync(path.join(out, 'summary.md'), `${summary.trimEnd()}\n`);
    if (perModel.some((m) => m.verdicts.regression === 'regression')) return 1;
    return perModel.every((m) => !Object.values(m.verdicts).includes('not measured') && m.decision.decision !== 'not measured') ? 0 : 2;
}

if (require.main === module) {
    main()
        .then((code) => process.exit(code))
        .catch((error) => {
            console.error(error);
            process.exit(2);
        });
}

module.exports = { main, runName, measuredAlready, compare, comparisonOf, deriveRuns, perCase, decide, decideAcrossModels, modelWorse, measureEach, reviewEnv, envHashOf, setIdentity, phaseVerdict, affectedSteps, setOf, reusableBase, keepBase, finderResult, PHASES, STEP_EVALS, BASE_REUSE_DAYS };
