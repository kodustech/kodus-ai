#!/usr/bin/env node
// The eval harness preflight: no model, no network. Checks that the files the
// evals load exist, that each eval's README carries the standard header and
// that its pointers resolve, and that the committed datasets are there. The
// wiring smoke (evals/wiring-smoke.js) runs it on every engine PR.
//
//   node evals/engine-gate.js [--profile=harness] [--strict-coverage]
//
// --strict-coverage  every warning fails too.
//
// Exit: 0 pass, 2 the harness is broken (fix it before trusting any number).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
    const out = { strictCoverage: false };
    for (const arg of argv.slice(2)) {
        if (arg === '--strict-coverage') out.strictCoverage = true;
        else if (arg === '--profile=harness') continue;
        else {
            console.error(`unknown argument '${arg}' (the preflight takes --profile=harness and --strict-coverage)`);
            process.exit(2);
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
        'evals/wiring-smoke.js',
        'evals/tier0-smoke.js',
        'evals/ci-report.js',
        'evals/shared/fake-llm-server.js',
        'evals/shared/trace-loaded.js',
        'evals/shared/engine-files.js',
        'evals/investigation/gate.js',
        'evals/investigation/confirm-gate.js',
        'evals/investigation/rejudge.js',
        'evals/investigation/nightly-compare.js',
        'evals/investigation/investigate-facts.js',
        'evals/investigation/investigate-prompt.md',
        'evals/investigation/extract-investigation.js',
        'evals/shared/tier0-models.js',
        'evals/investigation/run-recall.js',
        'evals/investigation/agent-provider.js',
        'evals/kody-rules/real-agent.js',
        'evals/kody-rules/github-cases.json',
        'evals/pr-summary/run.js',
        'evals/pr-summary/datasets/cases.json',
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

    // The eval docs point at files instead of copying facts; a stale pointer or a
    // README without the standard header fails here, on the PR that caused it.
    const { findBrokenReferences, missingHeaderFields, evalDocs } = require('./shared/doc-references');
    const scripts = readJson(path.join(ROOT, 'package.json')).scripts || {};
    const { entryPoints, readmes } = evalDocs(ROOT);
    let docProblems = 0;
    for (const doc of [...entryPoints, ...readmes]) {
        if (!fs.existsSync(path.join(ROOT, doc))) {
            fatal.push(`missing eval doc: ${doc}`);
            docProblems += 1;
            continue;
        }
        const markdown = fs.readFileSync(path.join(ROOT, doc), 'utf8');
        for (const broken of findBrokenReferences(markdown, { docPath: doc, root: ROOT, scripts })) {
            fatal.push(`${doc}: stale ${broken.kind} reference ${broken.ref}`);
            docProblems += 1;
        }
        if (readmes.includes(doc)) {
            const missing = missingHeaderFields(markdown);
            if (missing.length) {
                fatal.push(`${doc}: standard header is missing ${missing.join(', ')}`);
                docProblems += 1;
            }
        }
    }
    if (!docProblems) ok.push(`eval docs: ${entryPoints.length + readmes.length} checked, every pointer resolves`);

    const investigationCases = countJsonFiles(path.join(ROOT, 'evals/investigation/datasets'));

    if (investigationCases > 1) ok.push(`investigation datasets=${investigationCases}`);
    else fatal.push(`investigation dataset count too low (${investigationCases})`);

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

function main() {
    const args = parseArgs(process.argv);
    const result = preflight({ strictCoverage: args.strictCoverage });
    printPreflight(result);
    if (result.fatal.length > 0) {
        console.error('\nEval harness preflight failed. Fix these before trusting quality numbers.');
        process.exit(2);
    }
    console.log('\nHarness preflight passed. No model-backed evals were run.');
}

main();
