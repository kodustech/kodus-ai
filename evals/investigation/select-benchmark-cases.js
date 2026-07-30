#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const BENCHMARK_RESULTS_DIR = path.join(ROOT, 'scripts/benchmark/results');

const DEFAULT_RUNS = [
    'gpt54-final-r01',
    'gemini31pro-planner',
    'kimi25-moonshot',
];

const RESULT_PRIORITY = [
    'issue-critical',
    'severity',
    'with-warning',
    'issue-only',
];

function parseArgs(argv) {
    const args = {
        runs: [],
        top: 12,
        format: 'text',
        output: null,
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--run') {
            if (argv[i + 1]) args.runs.push(argv[i + 1]);
            i += 1;
            continue;
        }
        if (arg === '--top') {
            const parsed = Number(argv[i + 1]);
            if (Number.isFinite(parsed) && parsed > 0) args.top = Math.trunc(parsed);
            i += 1;
            continue;
        }
        if (arg === '--format') {
            const next = String(argv[i + 1] || '').trim().toLowerCase();
            if (next === 'json' || next === 'text') args.format = next;
            i += 1;
            continue;
        }
        if (arg === '--output') {
            args.output = argv[i + 1] ? path.resolve(argv[i + 1]) : null;
            i += 1;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }
    }

    if (!args.runs.length) args.runs = [...DEFAULT_RUNS];
    return args;
}

function printHelp() {
    console.log(`Select strong benchmark failures to convert into planner datasets.

Usage:
  node evals/investigation/select-benchmark-cases.js [options]

Options:
  --run <name[:level]>   Benchmark run to analyze. Repeatable.
                         If level is omitted, the script auto-picks from:
                         issue-critical > severity > with-warning > issue-only
  --top <n>              Number of candidates to print (default: 12)
  --format <text|json>   Output format (default: text)
  --output <path>        Also write the full result payload to JSON

Examples:
  node evals/investigation/select-benchmark-cases.js
  node evals/investigation/select-benchmark-cases.js \\
    --run gpt54-final-r01:severity \\
    --run gemini31pro-planner:issue-critical \\
    --run kimi25-moonshot:issue-critical
`);
}

function loadJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function ensureArray(value) {
    return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean))];
}

function normalizeRepo(repo) {
    return String(repo || '').replace(/^ai-code-review-benchmark\//, '');
}

function makeCaseKey(repo, sourceUrl, title) {
    return sourceUrl || `${normalizeRepo(repo)}::${String(title || '').trim()}`;
}

function discoverResultLevel(runName) {
    const runDir = path.join(BENCHMARK_RESULTS_DIR, runName);
    const files = fs
        .readdirSync(runDir)
        .filter((file) => /^results-.+\.json$/.test(file))
        .map((file) => file.replace(/^results-/, '').replace(/\.json$/, ''));

    for (const preferred of RESULT_PRIORITY) {
        if (files.includes(preferred)) return preferred;
    }

    return files[0] || null;
}

function parseRunSpec(runSpec) {
    const [runName, explicitLevel] = String(runSpec).split(':');
    return {
        runName,
        level: explicitLevel || null,
    };
}

function mergeIssueLists(existing, incoming) {
    const merged = new Map();
    for (const item of [...ensureArray(existing), ...ensureArray(incoming)]) {
        if (!item?.comment) continue;
        merged.set(item.comment, item);
    }
    return [...merged.values()];
}

function mergePerRunEntries(existing, incoming) {
    if (!existing) return incoming;

    return {
        ...existing,
        tp: Math.max(existing.tp, incoming.tp),
        fp: Math.max(existing.fp, incoming.fp),
        fn: Math.max(existing.fn, incoming.fn),
        golden: Math.max(existing.golden, incoming.golden),
        candidates: Math.max(existing.candidates, incoming.candidates),
        found: mergeIssueLists(existing.found, incoming.found),
        missed: mergeIssueLists(existing.missed, incoming.missed),
        noise: uniqueStrings([
            ...ensureArray(existing.noise),
            ...ensureArray(incoming.noise),
        ]),
    };
}

function loadRun(runSpec) {
    const { runName, level: explicitLevel } = parseRunSpec(runSpec);
    const runDir = path.join(BENCHMARK_RESULTS_DIR, runName);
    if (!fs.existsSync(runDir)) {
        throw new Error(`Benchmark results dir not found: ${runDir}`);
    }

    const level = explicitLevel || discoverResultLevel(runName);
    if (!level) {
        throw new Error(`No results-*.json found for run ${runName}`);
    }

    const resultsPath = path.join(runDir, `results-${level}.json`);
    const goldenPath = path.join(runDir, 'golden.json');
    if (!fs.existsSync(resultsPath)) {
        throw new Error(`Results file not found: ${resultsPath}`);
    }
    if (!fs.existsSync(goldenPath)) {
        throw new Error(`Golden file not found: ${goldenPath}`);
    }

    const results = loadJson(resultsPath);
    const golden = loadJson(goldenPath);
    const prResults = ensureArray(results.prResults);

    const perCase = new Map();
    const rowCount = Math.min(prResults.length, golden.length);

    for (let index = 0; index < rowCount; index += 1) {
        const prResult = prResults[index];
        const goldenRow = golden[index];
        const repo = normalizeRepo(goldenRow.repo || prResult.repo);
        const title = goldenRow.title || prResult.title;
        const sourceUrl = goldenRow.source_url || null;
        const key = makeCaseKey(repo, sourceUrl, title);

        const candidate = {
            key,
            repo,
            title,
            sourceUrl,
            head: goldenRow.head || null,
            level,
            runName,
            tp: prResult.tp || 0,
            fp: prResult.fp || 0,
            fn: prResult.fn || 0,
            golden: prResult.golden || ensureArray(goldenRow.golden_comments).length,
            candidates: prResult.candidates || 0,
            found: ensureArray(prResult.found),
            missed: ensureArray(prResult.missed),
            noise: ensureArray(prResult.noise),
        };

        perCase.set(key, mergePerRunEntries(perCase.get(key), candidate));
    }

    return {
        runName,
        level,
        cases: [...perCase.values()],
    };
}

function analyzeCase(caseEntry) {
    const runs = caseEntry.runs;
    const runEntries = Object.values(runs);
    const failedRuns = runEntries.filter((entry) => entry.fn > 0);
    const noCandidateRuns = runEntries.filter((entry) => entry.candidates === 0);
    const missedAllRuns = runEntries.filter(
        (entry) => entry.fn > 0 && entry.fn === entry.golden,
    );
    const noisyRuns = runEntries.filter((entry) => entry.fp > entry.tp);
    const successfulRuns = runEntries.filter((entry) => entry.fn === 0);
    const partialRuns = runEntries.filter((entry) => entry.tp > 0 && entry.fn > 0);

    const tags = [];
    if (missedAllRuns.length) tags.push('missed-all');
    if (noCandidateRuns.length) tags.push('no-candidate');
    if (partialRuns.length) tags.push('partial-recall');
    if (noisyRuns.length) tags.push('noise');
    if (successfulRuns.length && failedRuns.length) tags.push('disagreement');

    const score =
        missedAllRuns.length * 10 +
        noCandidateRuns.length * 8 +
        failedRuns.length * 4 +
        partialRuns.length * 2 +
        (successfulRuns.length && failedRuns.length ? 6 : 0) +
        noisyRuns.length;

    const topMissed = uniqueStrings(
        failedRuns.flatMap((entry) =>
            ensureArray(entry.missed)
                .slice(0, 3)
                .map((item) => item.comment),
        ),
    ).slice(0, 3);

    return {
        ...caseEntry,
        score,
        tags,
        failedRuns: failedRuns.length,
        noCandidateRuns: noCandidateRuns.length,
        missedAllRuns: missedAllRuns.length,
        noisyRuns: noisyRuns.length,
        topMissed,
        extractionCommand: `pnpm run eval:investigation:extract --title ${JSON.stringify(caseEntry.title)}`,
    };
}

function buildAggregate(runs) {
    const cases = new Map();

    for (const run of runs) {
        for (const entry of run.cases) {
            const existing = cases.get(entry.key) || {
                key: entry.key,
                repo: entry.repo,
                title: entry.title,
                sourceUrl: entry.sourceUrl,
                head: entry.head,
                runs: {},
            };

            existing.runs[run.runName] = {
                runName: run.runName,
                level: run.level,
                tp: entry.tp,
                fp: entry.fp,
                fn: entry.fn,
                golden: entry.golden,
                candidates: entry.candidates,
                found: entry.found,
                missed: entry.missed,
                noise: entry.noise,
            };
            cases.set(entry.key, existing);
        }
    }

    return [...cases.values()]
        .map(analyzeCase)
        .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            if (right.failedRuns !== left.failedRuns) {
                return right.failedRuns - left.failedRuns;
            }
            return left.title.localeCompare(right.title);
        });
}

function formatRunSummary(run) {
    return `${run.runName}[${run.level}] tp=${run.tp} fp=${run.fp} fn=${run.fn} cand=${run.candidates}`;
}

function formatTextReport(cases, selectedRuns) {
    const lines = [];
    lines.push('Benchmark planner candidates');
    lines.push('');
    lines.push(`Runs: ${selectedRuns.map((run) => `${run.runName}[${run.level}]`).join(', ')}`);
    lines.push('');

    for (const [index, entry] of cases.entries()) {
        lines.push(`${index + 1}. ${entry.title} (${entry.repo})`);
        lines.push(`   tags: ${entry.tags.join(', ') || 'none'} | score=${entry.score}`);
        if (entry.sourceUrl) lines.push(`   source: ${entry.sourceUrl}`);
        for (const run of Object.values(entry.runs)) {
            lines.push(`   - ${formatRunSummary(run)}`);
        }
        if (entry.topMissed.length) {
            lines.push(`   missed: ${entry.topMissed.join(' | ')}`);
        }
        lines.push(`   extract: ${entry.extractionCommand}`);
        lines.push('');
    }

    return lines.join('\n');
}

function main() {
    const args = parseArgs(process.argv);
    const selectedRuns = args.runs.map(loadRun);
    const aggregate = buildAggregate(selectedRuns).slice(0, args.top);

    const payload = {
        generatedAt: new Date().toISOString(),
        selectedRuns: selectedRuns.map((run) => ({
            runName: run.runName,
            level: run.level,
            caseCount: run.cases.length,
        })),
        candidates: aggregate,
    };

    if (args.output) {
        fs.mkdirSync(path.dirname(args.output), { recursive: true });
        fs.writeFileSync(args.output, JSON.stringify(payload, null, 2));
    }

    if (args.format === 'json') {
        console.log(JSON.stringify(payload, null, 2));
        return;
    }

    console.log(formatTextReport(aggregate, selectedRuns));
    if (args.output) {
        console.log(`\nWrote ${args.output}`);
    }
}

main();
