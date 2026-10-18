#!/usr/bin/env node
// Coding-agent instructions eval: does the generalist report changes that
// break the repository's CLAUDE.md, quoting it, without inventing violations
// and without the block leaking into runs where it is off?
//
// Runs production's review stage the way finder-recall does
// (evals/investigation/agent-provider.js), on cases built by ./cases.js: with
// the setting on, the team turned it on and the PR's target branch holds the
// case's CLAUDE.md. Scoring is deterministic: ground truth is the enumerated
// violation sites, no judge.
//
//   node evals/repo-instructions/run.js --model=<tier0 id> [--set=controlled|full] [--arm=both|on|off] [--cases=<id,id>] [--limit=N] [--concurrency=N] [--output=path] [--gate]
//
// The gated number counts the violation sites the review posts: what ships
// after the review's severity and quantity filters, with the team's default
// settings. What the finder reported before those filters is a diagnostic
// beside it (`reported`), and `metrics.on.shippedRate` is the share of the
// finder's instruction findings that reached the PR.
//
// Writes the shared result (evals/shared/eval-result.js): per case, the
// violation sites the on arm reported, out of all of them. --gate fails below
// the model's floor in ./targets.json, and on any repo_instruction finding in
// the off arm, whatever the floor.
//
// Exit: 0 pass, 1 below the floor or a leak (--gate), 2 did not measure (more
// than 5% of runs failed, or the result breaks the shared shape).
const fs = require('fs');
const path = require('path');

const { buildCases, casesFor, CASE_SETS, DECOY } = require('./cases');
const { catalog } = require('./catalog');
const { TIER0 } = require('../shared/tier0-models');
const { countTokens, tokensUsed } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');

const RESULTS_DIR = path.join(__dirname, '../investigation/results');
const LINE_TOLERANCE = 2;
const INFRA_BUDGET = 0.05;

function parseArgs(argv) {
    const out = { model: 'gpt-5.4', set: 'controlled', arm: 'both', cases: [], limit: null, concurrency: 4, output: '', gate: false };
    for (const arg of argv.slice(2)) {
        if (arg === '--gate') {
            out.gate = true;
            continue;
        }
        const m = arg.match(/^--([^=]+)=(.*)$/);
        if (!m) {
            console.error(`unknown argument ${arg}`);
            process.exit(2);
        }
        if (m[1] === 'model') out.model = m[2];
        else if (m[1] === 'arm') out.arm = m[2];
        else if (m[1] === 'set') out.set = m[2];
        else if (m[1] === 'limit') out.limit = Number(m[2]);
        else if (m[1] === 'cases') out.cases = m[2].split(',').map((id) => id.trim().replace(/^repo-instructions:/, '')).filter(Boolean);
        else if (m[1] === 'output') out.output = m[2];
        else if (m[1] === 'concurrency') out.concurrency = Math.max(1, Number(m[2]) || 1);
        else {
            console.error(`unknown flag --${m[1]}. Known: --model --set --arm --cases --limit --concurrency --output --gate`);
            process.exit(2);
        }
    }
    if (!(out.set in CASE_SETS)) {
        console.error(`--set must be ${Object.keys(CASE_SETS).join(' or ')} (got ${out.set})`);
        process.exit(2);
    }
    if (!['both', 'on', 'off'].includes(out.arm)) {
        console.error(`--arm must be both, on or off (got ${out.arm})`);
        process.exit(2);
    }
    if (!TIER0[out.model]) {
        console.error(`unknown tier0 model '${out.model}' (known: ${Object.keys(TIER0).join(', ')})`);
        process.exit(2);
    }
    return out;
}

const normalizeText = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ');

// The finding quotes the instruction: it names the file and repeats at least
// 20 consecutive characters of the convention.
function citesInstruction(finding, convention) {
    const text = normalizeText(finding.suggestionContent);
    if (!text.includes('claude.md')) return false;
    const rule = normalizeText(convention);
    for (let i = 0; i + 20 <= rule.length; i += 5) {
        if (text.includes(rule.slice(i, i + 20))) return true;
    }
    return false;
}

function overlaps(finding, line) {
    const start = Number(finding.relevantLinesStart);
    const end = Number(finding.relevantLinesEnd ?? finding.relevantLinesStart);
    if (!Number.isFinite(start)) return false;
    return line >= start - LINE_TOLERANCE && line <= (Number.isFinite(end) ? end : start) + LINE_TOLERANCE;
}

// `findings`: what the review ships; `loopFindings`: what the finder reported
// before the review's filters (the diagnostic).
function scoreOn(testCase, findings, loopFindings = []) {
    const instruction = findings.filter((f) => f.label === 'repo_instruction');
    const loopInstruction = loopFindings.filter((f) => f.label === 'repo_instruction');
    const sites = Object.entries(testCase.groundTruth).flatMap(([file, list]) =>
        list.map((o) => ({ file, line: o.line })),
    );
    const coveredBy = (list) =>
        sites.filter((s) => list.some((f) => f.relevantFile === s.file && overlaps(f, s.line))).length;
    const isTrue = (f) =>
        sites.some((s) => s.file === f.relevantFile && overlaps(f, s.line));
    const covered = sites.filter((s) =>
        instruction.some((f) => f.relevantFile === s.file && overlaps(f, s.line)),
    );
    const decoyPattern = /pnpm|package-lock|yarn\.lock/i;
    return {
        siteResults: sites.map((s) => ({
            what: `${s.file}:${s.line}`,
            ok: instruction.some((f) => f.relevantFile === s.file && overlaps(f, s.line)),
        })),
        instructionFindings: instruction.length,
        truePositives: instruction.filter(isTrue).length,
        sites: sites.length,
        sitesCovered: covered.length,
        cited: instruction.filter((f) => citesInstruction(f, testCase.convention)).length,
        decoyHits: instruction.filter((f) => decoyPattern.test(f.suggestionContent || '')).length,
        otherFindings: findings.length - instruction.length,
        loopSitesCovered: coveredBy(loopInstruction),
        loopInstructionFindings: loopInstruction.length,
    };
}

function scoreOff(findings) {
    return {
        leakedInstructionLabels: findings.filter((f) => f.label === 'repo_instruction').length,
        otherFindings: findings.length,
    };
}

const ratio = (a, b) => (b > 0 ? Number((a / b).toFixed(3)) : null);

function summarize(rows) {
    const on = rows.filter((r) => r.arm === 'on' && r.status === 'ok');
    const off = rows.filter((r) => r.arm === 'off' && r.status === 'ok');
    const sum = (list, key) => list.reduce((n, r) => n + (r.score[key] || 0), 0);
    return {
        on: on.length
            ? {
                  cases: on.length,
                  precision: ratio(sum(on, 'truePositives'), sum(on, 'instructionFindings')),
                  occurrenceRecall: ratio(sum(on, 'sitesCovered'), sum(on, 'sites')),
                  citationRate: ratio(sum(on, 'cited'), sum(on, 'instructionFindings')),
                  decoyHits: sum(on, 'decoyHits'),
                  instructionFindings: sum(on, 'instructionFindings'),
                  otherFindings: sum(on, 'otherFindings'),
                  loopOccurrenceRecall: ratio(sum(on, 'loopSitesCovered'), sum(on, 'sites')),
                  loopInstructionFindings: sum(on, 'loopInstructionFindings'),
                  shippedRate: ratio(sum(on, 'instructionFindings'), sum(on, 'loopInstructionFindings')),
              }
            : null,
        off: off.length
            ? {
                  cases: off.length,
                  leakedInstructionLabels: sum(off, 'leakedInstructionLabels'),
                  otherFindings: sum(off, 'otherFindings'),
              }
            : null,
    };
}

async function main() {
    const args = parseArgs(process.argv);
    countTokens();
    // --cases takes the Kody Rules case ids (evals/kody-rules/github-cases.json), from every case.
    let cases = args.cases.length
        ? buildCases().filter((c) => args.cases.includes(c.caseId.replace(/^repo-instructions:/, '')))
        : casesFor(args.set);
    if (Number.isFinite(args.limit)) cases = cases.slice(0, args.limit);
    const arms = args.arm === 'both' ? ['on', 'off'] : [args.arm];

    const InvestigationAgentProvider = require('../investigation/agent-provider');
    const provider = new InvestigationAgentProvider({
        config: { label: `${args.model}-repo-instructions`, provider: 'tier0', model: args.model },
    });

    console.log(`════ repo-instructions · model=${args.model} · set=${args.set} · arms=${arms.join(',')} · cases=${cases.length} · decoy="${DECOY}" ════`);

    const tasks = cases.flatMap((testCase) => arms.map((arm) => ({ testCase, arm })));
    const rows = [];
    const runTask = async ({ testCase, arm }) => {
        const vars = { ...testCase.vars, caseId: `${testCase.caseId}:${arm}` };
        if (arm === 'off') delete vars.repoInstructions;
        let result;
        try {
            result = await provider.callApi(JSON.stringify(vars), { vars }, {});
        } catch (error) {
            result = { error: error instanceof Error ? error.message : String(error) };
        }
        if (!result?.output) {
            rows.push({ caseId: testCase.caseId, arm, status: 'infra', reason: result?.error || 'no output' });
            console.log(`INFRA ${testCase.caseId} [${arm}] ${String(result?.error || 'no output').slice(0, 160)}`);
            return;
        }
        const output = JSON.parse(result.output);
        const findings = output.findings || [];
        const score = arm === 'on' ? scoreOn(testCase, findings, output.loopFindings || []) : scoreOff(findings);
        rows.push({ caseId: testCase.caseId, arm, status: 'ok', score, tokenUsage: result.tokenUsage });
        console.log(`OK    ${testCase.caseId} [${arm}] ${JSON.stringify(score)}`);
    };
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(args.concurrency, tasks.length) }, async () => {
            while (next < tasks.length) {
                // eslint-disable-next-line no-await-in-loop
                await runTask(tasks[next++]);
            }
        }),
    );

    const infra = rows.filter((r) => r.status === 'infra').length;
    const metrics = summarize(rows);
    const checksById = new Map(catalog('full').map((c) => [c.id, c.checks]));
    const resultCases = cases.map((testCase) => {
        const on = rows.find((r) => r.caseId === testCase.caseId && r.arm === 'on');
        const detail = on?.status === 'ok' ? on.score.siteResults : [];
        return {
            id: testCase.caseId,
            checks: checksById.get(testCase.caseId),
            hits: detail.filter((d) => d.ok).length,
            total: detail.length,
            detail,
            ...(on?.status === 'ok' ? {} : { unmeasured: true }),
        };
    });
    const floor = ((require('./targets.json').sets || {})[args.set]?.models || {})[args.model]?.floor ?? null;
    const leaks = metrics.off?.leakedInstructionLabels ?? 0;
    const result = {
        eval: 'repo-instructions',
        question: evalQuestion('evals/repo-instructions'),
        model: args.model,
        set: args.set,
        runs: 1,
        metric: {
            name: 'violation sites the review posts with the setting on',
            value: metrics.on?.occurrenceRecall ?? null,
            floor,
            baseline: null,
        },
        // Not gated: what the finder reported before the review's filters.
        reported: {
            name: "violation sites the finder reported, before the review's filters",
            value: metrics.on?.loopOccurrenceRecall ?? null,
        },
        cases: resultCases,
        tokens: tokensUsed(),
        infra: { errored: infra, total: rows.length },
        arms,
        metrics,
        rows,
    };
    const output = args.output || path.join(RESULTS_DIR, `repo-instructions-${args.model.replace(/[^\w.-]+/g, '-')}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`metrics ${JSON.stringify(metrics)}`);
    console.log(`wrote ${path.relative(process.cwd(), output)}`);

    if (rows.length === 0 || infra / rows.length > INFRA_BUDGET) {
        console.error(`not measured: ${infra} of ${rows.length} run(s) failed on infra (budget ${INFRA_BUDGET * 100}%)`);
        return 2;
    }
    if (arms.includes('on')) {
        const problems = resultProblems(result);
        if (problems.length) {
            console.error(`not measured: the result breaks the shared shape: ${problems.join('; ')}`);
            return 2;
        }
    }
    if (args.gate) {
        if (leaks > 0) {
            console.error(`gate: ${leaks} repo_instruction finding(s) with the setting off`);
            return 1;
        }
        if (floor === null) {
            console.error(`not gated: no floor for ${args.model} in evals/repo-instructions/targets.json; calibrate it first`);
            return 2;
        }
        if (result.metric.value !== null && result.metric.value < floor) {
            console.error(`gate: ${result.metric.value} below the floor ${floor} for ${args.model}`);
            return 1;
        }
    }
    return 0;
}

if (require.main === module) {
    main().then(
        (code) => process.exit(code),
        (error) => {
            console.error(`infra: ${error instanceof Error ? error.stack : String(error)}`);
            process.exit(2);
        },
    );
}

module.exports = { scoreOn, summarize };
