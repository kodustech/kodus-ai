#!/usr/bin/env node
// Coding-agent instructions eval: does the generalist report changes that
// break the repository's CLAUDE.md, quoting it, without inventing violations
// and without the block leaking into runs where it is off?
//
// Runs the live generalist through the same deterministic tool replay as
// finder-recall (evals/investigation/agent-provider.js), on cases built by
// ./cases.js. Scoring is deterministic: ground truth is the enumerated
// violation sites, no judge.
//
//   node evals/repo-instructions/run.js --model=<tier0 id> [--arm=both|on|off] [--limit=N] [--concurrency=N] [--output=path]
//
// Exit: 0 measured, 2 infra (more than 5% of runs failed). No floor yet: a
// floor needs two calibration runs of the same commit (evals/AGENTS.md).
const fs = require('fs');
const path = require('path');

const { buildCases, DECOY } = require('./cases');
const { TIER0 } = require('../shared/tier0-models');

const RESULTS_DIR = path.join(__dirname, '../investigation/results');
const LINE_TOLERANCE = 2;
const INFRA_BUDGET = 0.05;

function parseArgs(argv) {
    const out = { model: 'gpt-5.4', arm: 'both', limit: null, concurrency: 4, output: '' };
    for (const arg of argv.slice(2)) {
        const m = arg.match(/^--([^=]+)=(.*)$/);
        if (!m) {
            console.error(`unknown argument ${arg}`);
            process.exit(2);
        }
        if (m[1] === 'model') out.model = m[2];
        else if (m[1] === 'arm') out.arm = m[2];
        else if (m[1] === 'limit') out.limit = Number(m[2]);
        else if (m[1] === 'output') out.output = m[2];
        else if (m[1] === 'concurrency') out.concurrency = Math.max(1, Number(m[2]) || 1);
        else {
            console.error(`unknown flag --${m[1]}. Known: --model --arm --limit --concurrency --output`);
            process.exit(2);
        }
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

function scoreOn(testCase, findings) {
    const instruction = findings.filter((f) => f.label === 'repo_instruction');
    const sites = Object.entries(testCase.groundTruth).flatMap(([file, list]) =>
        list.map((o) => ({ file, line: o.line })),
    );
    const isTrue = (f) =>
        sites.some((s) => s.file === f.relevantFile && overlaps(f, s.line));
    const covered = sites.filter((s) =>
        instruction.some((f) => f.relevantFile === s.file && overlaps(f, s.line)),
    );
    const decoyPattern = /pnpm|package-lock|yarn\.lock/i;
    return {
        instructionFindings: instruction.length,
        truePositives: instruction.filter(isTrue).length,
        sites: sites.length,
        sitesCovered: covered.length,
        cited: instruction.filter((f) => citesInstruction(f, testCase.convention)).length,
        decoyHits: instruction.filter((f) => decoyPattern.test(f.suggestionContent || '')).length,
        otherFindings: findings.length - instruction.length,
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
    let cases = buildCases();
    if (Number.isFinite(args.limit)) cases = cases.slice(0, args.limit);
    const arms = args.arm === 'both' ? ['on', 'off'] : [args.arm];

    const InvestigationAgentProvider = require('../investigation/agent-provider');
    const provider = new InvestigationAgentProvider({
        config: { label: `${args.model}-repo-instructions`, provider: 'tier0', model: args.model },
    });

    console.log(`════ repo-instructions · model=${args.model} · arms=${arms.join(',')} · cases=${cases.length} · decoy="${DECOY}" ════`);

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
        const findings = JSON.parse(result.output).findings || [];
        const score = arm === 'on' ? scoreOn(testCase, findings) : scoreOff(findings);
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
    const report = {
        model: args.model,
        arms,
        cases: cases.length,
        runs: rows.length,
        infraFailures: infra,
        metrics: summarize(rows),
        rows,
    };
    const output = args.output || path.join(RESULTS_DIR, `repo-instructions-${args.model.replace(/[^\w.-]+/g, '-')}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(`metrics ${JSON.stringify(report.metrics)}`);
    console.log(`wrote ${path.relative(process.cwd(), output)}`);

    if (rows.length === 0 || infra / rows.length > INFRA_BUDGET) {
        console.error(`not measured: ${infra} of ${rows.length} run(s) failed on infra (budget ${INFRA_BUDGET * 100}%)`);
        process.exit(2);
    }
    process.exit(0);
}

main().catch((error) => {
    console.error(`infra: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(2);
});
