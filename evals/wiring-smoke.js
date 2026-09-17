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
//   node evals/wiring-smoke.js
//
// Exit: 0 every step drove the engine / 1 at least one step broke.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startFakeLlmServer } = require('./shared/fake-llm-server');

const ROOT = path.join(__dirname, '..');
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

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

async function main() {
    const server = await startFakeLlmServer();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-wiring-'));
    const finderOut = path.join(scratch, 'finder-recall-eval-fake.json');

    const env = {
        ...process.env,
        EVAL_FAKE_LLM_URL: server.url,
        EVAL_FAKE_LLM_KEY: 'fake',
        // The judge scores the one scripted finding against the goldens through
        // the same local server, so scoring is exercised without a key.
        JUDGE_MODEL: 'gpt-eval-fake',
        JUDGE_BASE_URL: server.url,
        API_OPEN_AI_API_KEY: 'fake',
        RECALL_DUMP: '',
    };

    // `model: true` steps must reach the scripted model at least once — a step
    // that exits 0 without calling it proves nothing about the engine path.
    const steps = [
        { name: 'preflight', args: ['evals/engine-gate.js', '--profile=harness'] },
        { name: 'review-chain', args: ['evals/review-chain/run.js', '--gate'] },
        { name: 'shape-invariance', args: ['evals/review-chain/shape-invariance.js', '--gate'] },
        { name: 'dedup', args: ['evals/dedup/run.js', '--mock=identity', '--gate'] },
        { name: 'severity', args: ['evals/severity/run.js', '--mock=heuristic', '--gate'] },
        { name: 'format', args: ['evals/format/run.js', '--mock=perfect', '--gate'] },
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
        { name: 'anchoring', model: true, args: ['evals/anchoring/anchor-eval.js', '--model=eval-fake', '--limit=1'] },
        { name: 'pr-summary', model: true, args: ['evals/pr-summary/run.js', '--model=eval-fake', '--gate'] },
    ];

    const results = [];
    for (const step of steps) {
        const before = server.stats.requests;
        // eslint-disable-next-line no-await-in-loop
        const { code, timedOut, output, ms } = await run(process.execPath, step.args, env);
        const calls = server.stats.requests - before;
        let problem = null;
        if (timedOut) problem = `did not exit within ${STEP_TIMEOUT_MS / 60000} min`;
        else if (code !== 0) problem = `exit ${code}`;
        else if (step.model && calls === 0) problem = 'never reached the model';
        else if (step.check) problem = step.check();
        results.push({ step, problem, calls, ms, output });
        console.log(`${problem ? '❌' : '✅'} ${step.name.padEnd(17)} ${String(Math.round(ms / 1000)).padStart(3)}s${step.model ? `  model calls=${calls}` : ''}${problem ? `  — ${problem}` : ''}`);
    }

    await server.close();
    fs.rmSync(scratch, { recursive: true, force: true });

    const broken = results.filter((r) => r.problem);
    if (!broken.length) {
        console.log('\nEvery eval still drives the engine.');
        return 0;
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
