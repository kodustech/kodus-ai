#!/usr/bin/env node
// Single entrypoint for code-review engine evals.
//
// Profiles:
//   harness  → no model/network; validates eval wiring and committed datasets.
//   local    → cheap model-backed gate for a developer branch.
//   branch   → downstream canary for a PR branch (finder matrix is separate).
//   ci       → post-merge suite profile; larger sample.
//
// This wrapper is intentionally thin. The per-eval runners keep their own
// metrics; this script gives local + CI one command and separates harness drift
// from quality failures.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
    const out = {
        profile: process.env.EVAL_PROFILE || 'harness',
        model: process.env.EVAL_MODEL || 'gpt-5.4',
        prs: null,
        runs: null,
        enforce: null,
        strictCoverage: false,
        extraSuiteArgs: [],
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
        if (!m) {
            out.extraSuiteArgs.push(arg);
            continue;
        }

        const key = m[1];
        const inlineValue = m[2];
        const value = inlineValue ?? argv[i + 1];
        const consumesNext = inlineValue === undefined && value && !String(value).startsWith('--');

        if (key === 'profile') {
            out.profile = value || out.profile;
            if (consumesNext) i += 1;
        } else if (key === 'model') {
            out.model = value || out.model;
            if (consumesNext) i += 1;
        } else if (key === 'prs') {
            out.prs = Number(value);
            if (consumesNext) i += 1;
        } else if (key === 'runs') {
            out.runs = Number(value);
            if (consumesNext) i += 1;
        } else if (key === 'enforce') {
            out.enforce = true;
        } else if (key === 'no-enforce') {
            out.enforce = false;
        } else if (key === 'strict-coverage') {
            out.strictCoverage = true;
        } else {
            out.extraSuiteArgs.push(arg);
        }
    }

    return out;
}

function rel(p) {
    return path.relative(ROOT, p);
}

function countJsonFiles(dir) {
    if (!fs.existsSync(dir)) return 0;
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .length;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function npmEvalScriptWarnings() {
    const pkg = readJson(path.join(ROOT, 'package.json'));
    const scripts = pkg.scripts || {};
    const warnings = [];

    for (const [name, command] of Object.entries(scripts)) {
        if (!name.startsWith('eval:')) continue;

        const cdMatch = String(command).match(/\bcd\s+([^&\s]+)\s+&&/);
        if (cdMatch) {
            const targetDir = path.join(ROOT, cdMatch[1]);
            if (!fs.existsSync(targetDir)) {
                warnings.push(`${name}: cd target is missing (${cdMatch[1]})`);
                continue;
            }
        }

        const localScriptMatch = String(command).match(/\b(cd\s+([^&\s]+)\s+&&\s+)?(?:bash\s+)?\.\/([^\s]+)/);
        if (localScriptMatch) {
            const baseDir = localScriptMatch[2]
                ? path.join(ROOT, localScriptMatch[2])
                : ROOT;
            const targetFile = path.join(baseDir, localScriptMatch[3]);
            if (!fs.existsSync(targetFile)) {
                warnings.push(`${name}: script target is missing (${rel(targetFile)})`);
            }
        }
    }

    return warnings;
}

function preflight({ strictCoverage }) {
    const fatal = [];
    const warnings = [];
    const ok = [];

    const requiredFiles = [
        'evals/run-suite.js',
        'evals/shared/tier0-models.js',
        'evals/investigation/run-eval.js',
        'evals/investigation/run-recall.js',
        'evals/investigation/compare-recall.js',
        'evals/investigation/agent-provider.js',
        'evals/promotion/run-eval.js',
        'evals/kody-rules/real-agent.js',
        'evals/kody-rules/github-cases.json',
        'evals/anchoring/anchor-eval.js',
        'evals/pr-summary/run.js',
        'evals/pr-summary/datasets/cases.json',
        'evals/dedup/run.js',
        'evals/dedup/dedup-runner.js',
        'libs/code-review/infrastructure/agents/providers/generalist-agent.provider.ts',
        'libs/code-review/infrastructure/agents/providers/kody-rules-agent.provider.ts',
        'libs/code-review/infrastructure/agents/core/core-agent-loop.adapter.ts',
        'libs/code-review/infrastructure/agents/engine/dedup-prompt.ts',
        'libs/llm/byok-to-vercel.ts',
    ];

    for (const file of requiredFiles) {
        const absolute = path.join(ROOT, file);
        if (fs.existsSync(absolute)) ok.push(file);
        else fatal.push(`missing required file: ${file}`);
    }

    const investigationCases = countJsonFiles(path.join(ROOT, 'evals/investigation/datasets'));
    const promotionCases = countJsonFiles(path.join(ROOT, 'evals/promotion/datasets'));
    const dedupCases = countJsonFiles(path.join(ROOT, 'evals/dedup/datasets'));

    if (investigationCases > 1) ok.push(`investigation datasets=${investigationCases}`);
    else fatal.push(`investigation dataset count too low (${investigationCases})`);

    if (promotionCases > 0) ok.push(`promotion datasets=${promotionCases}`);
    else fatal.push('promotion datasets missing');

    if (dedupCases > 0) ok.push(`dedup datasets=${dedupCases}`);
    else warnings.push('dedup datasets missing; dedup is not reproducible from a clean checkout');

    const kodyCasesFile = path.join(ROOT, 'evals/kody-rules/github-cases.json');
    if (fs.existsSync(kodyCasesFile)) {
        try {
            const cases = readJson(kodyCasesFile);
            if (Array.isArray(cases) && cases.length > 0) ok.push(`kody-rules cases=${cases.length}`);
            else fatal.push('kody-rules github-cases.json is empty or not an array');
        } catch (error) {
            fatal.push(`kody-rules github-cases.json is invalid JSON: ${error.message}`);
        }
    }

    const summaryCasesFile = path.join(ROOT, 'evals/pr-summary/datasets/cases.json');
    if (fs.existsSync(summaryCasesFile)) {
        try {
            const cases = readJson(summaryCasesFile);
            const behaviours = new Set((cases || []).map((c) => c.behaviour));
            if (!Array.isArray(cases) || cases.length === 0) {
                fatal.push('pr-summary cases.json is empty or not an array');
            } else if (!['replace', 'concatenate', 'complement'].every((b) => behaviours.has(b))) {
                fatal.push('pr-summary cases.json must cover replace, concatenate and complement');
            } else {
                ok.push(`pr-summary cases=${cases.length}`);
            }
        } catch (error) {
            fatal.push(`pr-summary cases.json is invalid JSON: ${error.message}`);
        }
    }

    warnings.push(...npmEvalScriptWarnings());

    if (strictCoverage) {
        fatal.push(...warnings.map((warning) => `coverage gap: ${warning}`));
        warnings.length = 0;
    }

    return { ok, warnings, fatal };
}

function printPreflight(result) {
    console.log('════ code-review eval preflight ════');
    for (const item of result.ok) console.log(`  OK    ${item}`);
    for (const item of result.warnings) console.log(`  WARN  ${item}`);
    for (const item of result.fatal) console.log(`  FAIL  ${item}`);
}

function suiteDefaults(profile) {
    if (profile === 'ci') return { prs: 5, runs: 3, enforce: true };
    if (profile === 'branch') return { prs: 3, runs: 1, enforce: true };
    if (profile === 'local') return { prs: 1, runs: 1, enforce: true };
    return { prs: 1, runs: 1, enforce: false };
}

function main() {
    const args = parseArgs(process.argv);
    const defaults = suiteDefaults(args.profile);
    const prs = Number.isFinite(args.prs) ? args.prs : defaults.prs;
    const runs = Number.isFinite(args.runs) ? args.runs : defaults.runs;
    const enforce = args.enforce === null ? defaults.enforce : args.enforce;
    const harnessOnly = args.profile === 'harness';

    const preflightResult = preflight({
        strictCoverage: args.strictCoverage,
    });
    printPreflight(preflightResult);

    if (preflightResult.fatal.length > 0) {
        console.error('\nEval harness preflight failed. Fix these before trusting quality numbers.');
        process.exit(2);
    }

    if (harnessOnly) {
        console.log('\nHarness preflight passed. No model-backed evals were run.');
        process.exit(0);
    }

    const suiteArgs = [
        'evals/run-suite.js',
        `--model=${args.model}`,
        `--prs=${prs}`,
        `--runs=${runs}`,
        ...(enforce ? ['--enforce'] : []),
        ...args.extraSuiteArgs,
    ];

    console.log(
        `\n════ running engine suite · profile=${args.profile} · model=${args.model} · prs=${prs} · runs=${runs} · enforce=${enforce} ════`,
    );

    const result = spawnSync(process.execPath, suiteArgs, {
        cwd: ROOT,
        stdio: 'inherit',
        env: process.env,
    });

    if (result.error) {
        console.error(result.error);
        process.exit(2);
    }

    process.exit(result.status || 0);
}

main();
