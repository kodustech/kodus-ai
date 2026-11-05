#!/usr/bin/env node
// gold-v3-recall: scores a finder-recall run (evals/investigation/run-recall.js
// with RECALL_DUMP) against our golden set, evals/dedup/gold-v3/golden.json.
//
//   node evals/gold-v3-recall/score.js --dump=<RECALL_DUMP dir> [--out=<dir>] [--concurrency=4] [--dry-run]
//
// A comment the judge matches to a golden issue is a TP; every other comment
// is a FP (no second pass against the known FPs). Recall = golden issues
// matched / golden issues; precision = matched comments / comments.
// Scored per line, each line a point of the review the run reached:
//   finder   every candidate the finder's passes produced, before the verify
//   verify   what the verify kept (runs with RECALL_STAGES=verify or full)
//   shipped  what the review hands to posting (RECALL_STAGES=full)
// Exit: 0 scored, 2 not measured (no judge key, an unreadable dump, more than
// 5% of cases unscored).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { judgeCase, judgeKey, JUDGE_MODEL, JUDGE_EFFORT, RULE } = require('./judge');

const ROOT = path.join(__dirname, '../..');
const GOLD = path.join(ROOT, 'evals/dedup/gold-v3');
const BENCH_ROOT = process.env.BENCH_REPOS_ROOT || path.join(process.env.HOME || '', 'projects/benchmark');

function parseArgs(argv) {
    const out = { dump: '', out: '', concurrency: 4, dryRun: false };
    for (const arg of argv.slice(2)) {
        const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
        if (!m) continue;
        if (m[1] === 'dump') out.dump = m[2];
        else if (m[1] === 'out') out.out = m[2];
        else if (m[1] === 'concurrency') out.concurrency = Number(m[2]) || 4;
        else if (m[1] === 'dry-run') out.dryRun = true;
        else {
            console.error(`unknown flag --${m[1]}. Known: --dump --out --concurrency --dry-run`);
            process.exit(2);
        }
    }
    if (!out.dump) {
        console.error('--dump=<RECALL_DUMP dir> is required');
        process.exit(2);
    }
    out.out = out.out || path.join(out.dump, 'gold-v3');
    return out;
}

const keyOf = (c) => [c.file, c.start ?? '', c.end ?? '', c.text].join('::');
const commentOf = (f, extra = {}) => ({
    file: f.relevantFile ?? null,
    start: f.relevantLinesStart ?? null,
    end: f.relevantLinesEnd ?? null,
    text: f.suggestionContent || '',
    ...extra,
});

/** The comments of each line one case's dump holds, and the stages it ran. */
function linesOf(output) {
    const stages = output.manifest?.stages || 'full';
    const finder = [];
    const verify = [];
    for (const run of output.finderPasses || []) {
        const first = (run.verify || []).find((v) => v.pass === 'verify');
        if (!first) continue;
        if (!first.items) throw new Error('the dump has no candidate items: re-run with the current harness');
        first.items.forEach((item, i) => {
            const cand = run.candidates?.[i] || {};
            const c = commentOf(item, { origin: cand.origin || null, agent: run.agentName });
            finder.push(c);
            if (cand.verify === 'kept') verify.push(c);
        });
    }
    const lines = { finder };
    if (stages !== 'finder') lines.verify = verify;
    if (stages === 'full') lines.shipped = (output.findings || []).map((f) => commentOf(f));
    return { stages, lines };
}

function loadDump(dir) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.raw.txt'));
    if (!files.length) throw new Error(`no *.raw.txt in ${dir}`);
    return files.map((f) => {
        const output = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { caseId: output.caseId || path.basename(f, '.raw.txt'), output };
    });
}

const pct = (n, d) => (d ? n / d : null);
const fmt = (v) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);

// The gold v3's official ruler (kodus-eval-runs tools/score.py, the 27/10
// round's placar): a valid TP is a golden TP, not a nit, confirmed or
// discontinued upstream (not pending, not one that never reached the original).
const NOT_VALID_UPSTREAM = new Set(['pendente', 'nao_entrou_no_original']);
function validIssues(goldItems, upstream) {
    return new Set(
        goldItems
            .filter((r) => r.class === 'TP' && !r.subclass && !NOT_VALID_UPSTREAM.has(upstream[r.issueId]))
            .map((r) => r.issueId),
    );
}

// A line of one case: each valid TP counts once, however many comments name
// it; every other comment (a repeat, a nit, a pending TP, "new") is a FP.
function scoreLine(comments, answers, valid) {
    const found = new Set();
    const byOrigin = {};
    for (const c of comments) {
        const a = answers.get(c.id);
        const hit = !!a && valid.has(a.match);
        const first = hit && !found.has(a.match);
        if (hit) found.add(a.match);
        if (c.origin) {
            const o = (byOrigin[c.origin] = byOrigin[c.origin] || { comments: 0, issues: new Set() });
            o.comments += 1;
            if (hit) o.issues.add(a.match);
        }
    }
    return {
        comments: comments.length,
        tp: found.size,
        fp: comments.length - found.size,
        valid: valid.size,
        found: [...found],
        byOrigin: Object.fromEntries(Object.entries(byOrigin).map(([k, v]) => [k, { comments: v.comments, issues: [...v.issues] }])),
    };
}

function pool(rows, line) {
    const t = { comments: 0, tp: 0, valid: 0, cases: 0 };
    const origins = {};
    for (const r of rows) {
        const s = r.lines?.[line];
        if (!s) continue;
        t.cases += 1;
        t.comments += s.comments;
        t.tp += s.tp;
        t.valid += s.valid;
        for (const [o, v] of Object.entries(s.byOrigin || {})) {
            const p = (origins[o] = origins[o] || { comments: 0, issues: 0 });
            p.comments += v.comments;
            p.issues += v.issues.length;
        }
    }
    const recall = pct(t.tp, t.valid);
    const precision = pct(t.tp, t.comments);
    const f = (b) => (recall && precision ? ((1 + b * b) * precision * recall) / (b * b * precision + recall) : 0);
    return { ...t, fp: t.comments - t.tp, recall, precision, f1: f(1), f2: f(2), byOrigin: origins };
}

async function main() {
    const args = parseArgs(process.argv);
    const gold = JSON.parse(fs.readFileSync(path.join(GOLD, 'golden.json'), 'utf8')).prs;
    const judgeIssues = JSON.parse(fs.readFileSync(path.join(GOLD, 'judge-issues.json'), 'utf8')).cases;
    const repos = JSON.parse(fs.readFileSync(path.join(GOLD, 'repos.json'), 'utf8'));
    const upstream = Object.fromEntries(
        Object.values(JSON.parse(fs.readFileSync(path.join(GOLD, 'upstream-verification.json'), 'utf8')).prs).flatMap((p) => Object.entries(p.tps).map(([id, v]) => [id, v.status])),
    );
    if (!args.dryRun && !judgeKey()) {
        console.error(`not measured: no key for the judge ${JUDGE_MODEL} (API_ANTHROPIC_API_KEY)`);
        process.exit(2);
    }
    fs.mkdirSync(path.join(args.out, 'judge'), { recursive: true });

    let cases;
    try {
        cases = loadDump(args.dump);
    } catch (error) {
        console.error(`not measured: ${error.message}`);
        process.exit(2);
    }
    const ruleHash = crypto.createHash('sha256').update(RULE + JUDGE_MODEL + JUDGE_EFFORT).digest('hex').slice(0, 12);
    const rows = [];
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, ms: 0 };
    let unscored = 0;

    const scoreOne = async ({ caseId, output }) => {
        const issues = judgeIssues[caseId]?.issues;
        const repo = repos[caseId];
        if (!issues || !gold[caseId] || !repo) {
            rows.push({ caseId, status: 'unscored', reason: 'case not in the gold v3' });
            unscored += 1;
            return;
        }
        const { stages, lines } = linesOf(output);
        // Every distinct comment of the case once: a line is a subset of them.
        const unique = new Map();
        for (const list of Object.values(lines)) {
            for (const c of list) if (!unique.has(keyOf(c))) unique.set(keyOf(c), { id: `C${unique.size + 1}`, file: c.file, lines: [c.start, c.end], text: c.text });
        }
        for (const list of Object.values(lines)) for (const c of list) c.id = unique.get(keyOf(c)).id;
        const comments = [...unique.values()];

        let answers = new Map();
        if (comments.length && !args.dryRun) {
            const inputHash = crypto.createHash('sha256').update(JSON.stringify({ ruleHash, comments, issues })).digest('hex').slice(0, 16);
            const cacheFile = path.join(args.out, 'judge', `${caseId}.json`);
            const cached = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : null;
            if (cached && cached.inputHash === inputHash) {
                answers = new Map(Object.entries(cached.answers));
            } else {
                try {
                    const r = await judgeCase({
                        caseId,
                        prTitle: judgeIssues[caseId].prTitle,
                        repoDir: path.join(BENCH_ROOT, repo.repo),
                        head: repo.head,
                        issues,
                        comments,
                    });
                    answers = r.answers;
                    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls']) usage[k] += r.usage[k];
                    usage.ms += r.ms;
                    fs.writeFileSync(cacheFile, JSON.stringify({ caseId, inputHash, judge: JUDGE_MODEL, effort: JUDGE_EFFORT, ruleHash, usage: r.usage, ms: r.ms, turns: r.turns, comments, answers: Object.fromEntries(answers) }, null, 1));
                } catch (error) {
                    rows.push({ caseId, status: 'unscored', reason: `judge: ${error.message}` });
                    unscored += 1;
                    console.log(`UNSCORED ${caseId}: ${error.message.slice(0, 200)}`);
                    return;
                }
            }
        }
        const valid = validIssues(gold[caseId], upstream);
        const scored = Object.fromEntries(Object.entries(lines).map(([line, list]) => [line, scoreLine(list, answers, valid)]));
        rows.push({ caseId, status: args.dryRun ? 'dry-run' : 'scored', stages, comments: comments.length, lines: scored });
        const last = scored.shipped || scored.verify || scored.finder;
        console.log(`${args.dryRun ? 'DRY   ' : 'SCORED'} ${caseId} comments=${comments.length} valid TPs found=${last.tp}/${last.valid}`);
    };

    let cursor = 0;
    const worker = async () => {
        while (cursor < cases.length) await scoreOne(cases[cursor++]);
    };
    await Promise.all(Array.from({ length: Math.min(args.concurrency, cases.length) }, worker));
    rows.sort((a, b) => a.caseId.localeCompare(b.caseId));

    const lineNames = ['finder', 'verify', 'shipped'].filter((l) => rows.some((r) => r.lines?.[l]));
    const metrics = Object.fromEntries(lineNames.map((l) => [l, pool(rows.filter((r) => r.status === 'scored'), l)]));
    const result = {
        eval: 'gold-v3-recall',
        dump: path.resolve(args.dump),
        gold: 'evals/dedup/gold-v3/golden.json',
        judge: { model: JUDGE_MODEL, effort: JUDGE_EFFORT, ruleHash },
        dryRun: args.dryRun,
        cases: rows.length,
        unscored,
        usage,
        metrics,
        rows,
    };
    fs.writeFileSync(path.join(args.out, 'result.json'), JSON.stringify(result, null, 1));

    const md = [
        `# gold v3 · ${path.basename(path.resolve(args.dump))}`,
        '',
        `Judge ${JUDGE_MODEL} (effort ${JUDGE_EFFORT}). TP = a valid gold v3 TP (not a nit, confirmed or discontinued upstream), counted once; every other comment is FP. Cases scored: ${rows.length - unscored}/${rows.length}.`,
        '',
        '| line | comments | TP | FP | recall | precision | F1 | F2 |',
        '|---|---:|---:|---:|---:|---:|---:|---:|',
        ...lineNames.map((l) => {
            const m = metrics[l];
            return `| ${l} | ${m.comments} | ${m.tp} | ${m.fp} | ${m.tp}/${m.valid} = ${fmt(m.recall)} | ${fmt(m.precision)} | ${fmt(m.f1)} | ${fmt(m.f2)} |`;
        }),
        '',
        metrics.finder ? '**Finder candidates by pass** (an issue found by two passes counts in each)' : '',
        '',
        ...(metrics.finder ? ['| pass | comments | valid TPs found |', '|---|---:|---:|', ...Object.entries(metrics.finder.byOrigin).map(([o, v]) => `| ${o} | ${v.comments} | ${v.issues} |`)] : []),
        '',
        `Judge use: ${usage.calls} calls, ${usage.input} in / ${usage.output} out tokens, cache read ${usage.cacheRead}.`,
    ].join('\n');
    fs.writeFileSync(path.join(args.out, 'summary.md'), md);
    console.log(`\n${md}\n\n${path.join(args.out, 'result.json')}`);

    if (unscored > Math.floor(rows.length * 0.05)) {
        console.error(`not measured: ${unscored}/${rows.length} cases unscored (over 5%)`);
        process.exit(2);
    }
    process.exit(0);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`not measured: ${error.stack || error}`);
        process.exit(2);
    });
}

module.exports = { linesOf, scoreLine, pool, validIssues };
