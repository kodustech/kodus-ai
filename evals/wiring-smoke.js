#!/usr/bin/env node
// Eval wiring smoke — the PR check. No keys, no cost, a few minutes.
//
// The replay evals call production code directly, so a refactor that renames a
// method, moves a file or adds a dependency breaks the EVAL without breaking the
// engine. Until now that surfaced only in the post-merge suite, as "INFRA error"
// in every model, and was indistinguishable from a bad key — the suite stayed
// red for two weeks and was switched off (resolveTaskSlot, agent-loop.ts, the
// review-chain manifest all drifted this way).
//
// This runs every model-backed eval end-to-end against a scripted local model
// (evals/shared/fake-llm-server.js) through the real self-hosted route, plus the
// deterministic evals. It measures nothing. It fails when the harness can no
// longer drive the engine, in the PR that broke it.
//
// It also records every repo file each step loads (shared/trace-loaded.js) and
// fails if one falls outside the PR workflow's `paths` filter, so the check
// can't stop firing for code the evals depend on. With --engine-files=<file> it
// writes what finder-recall loaded, and with --kody-rules-files=<file> what the
// kody-rules eval loaded, and with --eval-files-dir=<dir> what every step
// loaded (<dir>/<step>.txt, for evals/nightly-evals.js): the nightly measures
// each one only when one of its files changed.
//
//   node evals/wiring-smoke.js [--engine-files=<file>] [--kody-rules-files=<file>] [--eval-files-dir=<dir>] [--results=<file>]
//
// --results writes one entry per step ({ step, ok, problem, ms, calls }), which
// evals/stage-signals.js turns into one quality signal per review stage.
//
// Exit: 0 every step drove the engine / 1 at least one step broke.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startFakeLlmServer } = require('./shared/fake-llm-server');
const { readTrace, uncovered } = require('./shared/engine-files');
const { DECOY: REPO_INSTRUCTIONS_DECOY } = require('./repo-instructions/cases');
const { resultProblems } = require('./shared/eval-result');

const ROOT = path.join(__dirname, '..');
const PR_WORKFLOW = '.github/workflows/code-review-evals-pr.yml';
const FINDER_CASE = 'add-guest-management-functionality-to-existing-bookings-cal-com';
// Each step takes seconds against the scripted model. Minutes means it hangs
// (a finished eval that never exits), which is a break in its own right.
const STEP_TIMEOUT_MS = 3 * 60 * 1000;

function run(cmd, args, env) {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, STEP_TIMEOUT_MS);
        child.stdout.on('data', (chunk) => {
            output += chunk;
        });
        child.stderr.on('data', (chunk) => {
            output += chunk;
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, timedOut, output, ms: Date.now() - started });
        });
    });
}

function prWorkflowPaths() {
    const yaml = require('js-yaml');
    const workflow = yaml.load(fs.readFileSync(path.join(ROOT, PR_WORKFLOW), 'utf8'));
    return workflow?.on?.pull_request?.paths || [];
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

async function main() {
    const engineFilesOut = (process.argv.find((a) => a.startsWith('--engine-files=')) || '').split('=')[1];
    const kodyRulesFilesOut = (process.argv.find((a) => a.startsWith('--kody-rules-files=')) || '').split('=')[1];
    const evalFilesDir = (process.argv.find((a) => a.startsWith('--eval-files-dir=')) || '').split('=')[1];
    const resultsOut = (process.argv.find((a) => a.startsWith('--results=')) || '').split('=')[1];
    const server = await startFakeLlmServer();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-wiring-'));
    const finderOut = path.join(scratch, 'finder-recall-eval-fake.json');
    const traceDir = path.join(scratch, 'trace');
    const reviewCasesFile = path.join(scratch, 'review-cases.json');
    fs.writeFileSync(reviewCasesFile, JSON.stringify({ cases: require('./review-rounds/cases').cases }));

    const env = {
        ...process.env,
        EVAL_FAKE_LLM_URL: server.url,
        EVAL_FAKE_LLM_KEY: 'fake',
        // The judge scores the one scripted finding against the goldens through
        // the same local server, so scoring is exercised without a key.
        JUDGE_MODEL: 'gpt-eval-fake',
        JUDGE_BASE_URL: server.url,
        JUDGE_API_KEY: 'fake',
        RECALL_DUMP: '',
        TRACE_LOADED_DIR: traceDir,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${path.join(__dirname, 'shared', 'trace-loaded.js')}`.trim(),
    };

    // `model: true` steps must reach the scripted model at least once — a step
    // that exits 0 without calling it proves nothing about the engine path.
    const steps = [
        { name: 'preflight', args: ['evals/engine-gate.js', '--profile=harness'] },
        // Replays recorded model output; only prose recovery reaches the model.
        { name: 'parse', model: true, args: ['evals/parse/run.js', '--model=eval-fake', '--gate'] },
        { name: 'review-chain', args: ['evals/review-chain/run.js', '--gate'] },
        { name: 'shape-invariance', args: ['evals/review-chain/shape-invariance.js', '--gate'] },
        { name: 'verifier-verdict', args: ['evals/verifier-verdict/run.js', '--gate'] },
        { name: 'dedup', args: ['evals/dedup/run.js', '--mock=identity', '--gate'] },
        // The live dedup runner goes through LLM.run like the stage does.
        { name: 'dedup-engine', model: true, args: ['evals/dedup/run.js', '--model=eval-fake'] },
        { name: 'severity', args: ['evals/severity/run.js', '--mock=heuristic', '--gate'] },
        // The scripted model answers nothing usable: this measures the local fallback.
        { name: 'format', model: true, args: ['evals/format/run.js', '--model=eval-fake', '--gate'] },
        // The cases bring their repository: the scripted model reads it through the local sandbox.
        { name: 'memories', model: true, args: ['evals/memories/run.js', '--model=eval-fake', '--gate'] },
        {
            name: 'finder-recall',
            model: true,
            args: ['evals/investigation/run-recall.js', '--model=eval-fake', `--cases=${FINDER_CASE}`, '--concurrency=1', `--output=${finderOut}`],
            // The scripted model submits one finding; it must survive to scoring,
            // otherwise a parse/verify break that drops everything would pass.
            check: () => {
                const findings = readJson(finderOut)?.rows?.[0]?.metadata?.findings;
                return findings >= 1 ? null : `expected the scripted finding to reach scoring, got findings=${findings}`;
            },
        },
        { name: 'kody-rules', model: true, args: ['evals/kody-rules/real-agent.js', '--dataset=github-cases', '--model=eval-fake', '--runs=1', '--limit=1'] },
        {
            name: 'repo-instructions',
            model: true,
            args: ['evals/repo-instructions/run.js', '--model=eval-fake', '--limit=1', `--output=${path.join(scratch, 'repo-instructions.json')}`],
            // The finder only gets the index; it must read the CLAUDE.md through
            // readRepoInstruction. The scripted finding is labeled
            // repo_instruction once the index is in the prompt; the verifier
            // must then get the instruction files.
            check: (verdictPrompts, finderToolResults) => {
                if (!finderToolResults.some((t) => t.includes(REPO_INSTRUCTIONS_DECOY))) {
                    return 'expected the finder to read the CLAUDE.md through readRepoInstruction, no tool result carried it';
                }
                if (!verdictPrompts.some((p) => p.includes('labeled repo_instruction') && p.includes(REPO_INSTRUCTIONS_DECOY))) {
                    return `expected a verifier prompt carrying the CLAUDE.md, got ${verdictPrompts.length} verifier prompt(s) without it`;
                }
                const problems = resultProblems(readJson(path.join(scratch, 'repo-instructions.json')));
                return problems.length ? `result breaks the shared shape: ${problems.join('; ')}` : null;
            },
        },
        { name: 'anchoring', model: true, args: ['evals/anchoring/anchor-eval.js', '--model=eval-fake', '--limit=1'] },
        { name: 'pr-summary', model: true, args: ['evals/pr-summary/run.js', '--model=eval-fake', '--gate'] },
        { name: 'reply-addressing', model: true, args: ['evals/reply-addressing/run.js', '--model=eval-fake', '--limit=2'] },
        { name: 'review-rounds', model: true, args: ['evals/review-rounds/run.js', '--model=eval-fake', `--cases-file=${reviewCasesFile}`, '--case=R2,K1', '--reps=1', `--output=${path.join(scratch, 'review-rounds.json')}`] },
        { name: 'review-lifecycle', model: true, args: ['evals/review-rounds/lifecycle.js', '--model=eval-fake', '--reps=1', '--wiring-smoke', `--output=${path.join(scratch, 'review-lifecycle.json')}`] },
    ];

    const results = [];
    for (const step of steps) {
        const before = server.stats.requests;
        const verdictsBefore = server.stats.verdictPrompts.length;
        const toolResultsBefore = server.stats.finderToolResults.length;
        // eslint-disable-next-line no-await-in-loop
        const { code, timedOut, output, ms } = await run(process.execPath, step.args, { ...env, TRACE_LOADED_LABEL: step.name });
        const calls = server.stats.requests - before;
        let problem = null;
        if (timedOut) problem = `did not exit within ${STEP_TIMEOUT_MS / 60000} min`;
        else if (code !== 0) problem = `exit ${code}`;
        else if (step.model && calls === 0) problem = 'never reached the model';
        else if (step.check) problem = step.check(server.stats.verdictPrompts.slice(verdictsBefore), server.stats.finderToolResults.slice(toolResultsBefore));
        results.push({ step, problem, calls, ms, output });
        console.log(`${problem ? '❌' : '✅'} ${step.name.padEnd(17)} ${String(Math.round(ms / 1000)).padStart(3)}s${step.model ? `  model calls=${calls}` : ''}${problem ? `  — ${problem}` : ''}`);
    }

    await server.close();

    // The PR check must fire on every file an eval loads. A step whose trace
    // lacks its own runner was not recorded properly; trusting it would narrow
    // the filter check and let the nightly skip real changes.
    const loaded = fs.existsSync(traceDir) ? readTrace(traceDir) : [];
    const untraced = steps.filter((step) => !(fs.existsSync(traceDir) && readTrace(traceDir, step.name).includes(step.args[0])));
    const outside = uncovered(loaded, prWorkflowPaths());
    const coverageProblem = untraced.length
        ? `incomplete trace for ${untraced.map((step) => step.name).join(', ')} — its runner is missing from what it loaded`
        : outside.length
          ? `${outside.length} loaded file(s) outside the paths filter of ${PR_WORKFLOW}, e.g. ${outside.slice(0, 5).join(', ')}`
          : null;
    console.log(`${coverageProblem ? '❌' : '✅'} ${'pr paths filter'.padEnd(17)} ${loaded.length} repo files loaded${coverageProblem ? `  — ${coverageProblem}` : ', all covered'}`);

    if (engineFilesOut) {
        const finderFiles = fs.existsSync(traceDir) ? readTrace(traceDir, 'finder-recall') : [];
        fs.writeFileSync(engineFilesOut, `${finderFiles.join('\n')}\n`);
        console.log(`   engine files for the nightly: ${finderFiles.length} → ${engineFilesOut}`);
    }
    if (evalFilesDir) {
        fs.mkdirSync(evalFilesDir, { recursive: true });
        for (const step of steps) {
            const files = fs.existsSync(traceDir) ? readTrace(traceDir, step.name) : [];
            fs.writeFileSync(path.join(evalFilesDir, `${step.name}.txt`), `${files.join('\n')}\n`);
        }
        console.log(`   files per step for the nightly: ${steps.length} lists → ${evalFilesDir}`);
    }
    if (kodyRulesFilesOut) {
        const kodyRulesFiles = fs.existsSync(traceDir) ? readTrace(traceDir, 'kody-rules') : [];
        fs.writeFileSync(kodyRulesFilesOut, `${kodyRulesFiles.join('\n')}\n`);
        console.log(`   kody-rules files for the nightly: ${kodyRulesFiles.length} → ${kodyRulesFilesOut}`);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    if (resultsOut) {
        const entries = results.map((r) => ({ step: r.step.name, ok: !r.problem, problem: r.problem, ms: Math.round(r.ms), calls: r.calls }));
        // The trace check fails the smoke on its own; recorded as an entry no stage
        // claims, so evals/stage-signals.js reads every stage as untrusted, not green.
        entries.push({ step: 'pr-paths-filter', ok: !coverageProblem, problem: coverageProblem, ms: 0, calls: 0 });
        fs.writeFileSync(resultsOut, `${JSON.stringify(entries, null, 2)}\n`);
    }

    const broken = results.filter((r) => r.problem);
    if (!broken.length && !coverageProblem) {
        console.log('\nEvery eval still drives the engine.');
        return 0;
    }
    if (coverageProblem && !broken.length) {
        console.log(untraced.length ? '\nThe load trace is incomplete; its file lists cannot be trusted.' : `\nAdd the missing paths to ${PR_WORKFLOW} so the PR check runs when they change.`);
        return 1;
    }
    for (const r of broken) {
        const tail = r.output.split('\n').filter((line) => line.trim()).slice(-40).join('\n');
        console.log(`\n──── ${r.step.name}: ${r.problem} ────\n$ node ${r.step.args.join(' ')}\n${tail}`);
    }
    console.log(`\n${broken.length} eval(s) can no longer drive the engine. Fix the eval in this PR — the nightly would only report it as INFRA.`);
    return 1;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
