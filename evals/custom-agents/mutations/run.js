#!/usr/bin/env node
// Proves each property of custom agents can fail (evals/README.md rule 7): for
// every mutation here, apply its patch to production's code, run the checks
// that hold the property, expect each to go red, revert, and print a table.
//
//   node evals/custom-agents/mutations/run.js [--only=P3,P5] [--model=<tier-0 id>] [--skip-model]
//
// A check is a jest spec (red: jest fails) or this eval's gate (red: exit 1;
// exit 2 is "not measured", never red). The eval runs on the scripted model
// (no key) for what the review hands each agent, and on --model (default the
// nightly's) for what needs a model's judgement; without its key that check
// reports "not measured". The tree must be clean in every file a patch touches,
// and is checked clean again after each revert.
//
// Exit: 0 every measured check went red and the tree is restored, 1 a check
// stayed green (the property is not proven falsifiable by it), 2 a patch did
// not apply, the tree was not restored, nothing was selected, or more than 5%
// of the checks were not measured (--skip-model included).
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { startFakeLlmServer } = require('../../shared/fake-llm-server');

const ROOT = path.join(__dirname, '../../..');
const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const MODEL = args.model || 'deepseek-v4-flash@fireworks';

const SPEC = {
    provider:
        'libs/code-review/infrastructure/agents/providers/custom-agent.provider.spec.ts',
    prompt: 'libs/code-review/infrastructure/agents/prompts/prompt-builder.custom-agent.spec.ts',
    scope: 'libs/code-review/infrastructure/agents/custom-agents/custom-agent-scope.spec.ts',
    orchestrator:
        'libs/code-review/infrastructure/agents/review-orchestrator.custom-agents.spec.ts',
    stage: 'libs/code-review/pipeline/stages/agent-review.stage.custom-agents.spec.ts',
    fetch: 'libs/code-review/pipeline/stages/fetch-changed-files.stage.spec.ts',
    quote: 'libs/code-review/infrastructure/agents/core/convention-check.spec.ts',
    cascade:
        'libs/ee/codeBase/__tests__/directory-custom-agents-cascade.spec.ts',
};

// The cases whose checks a model-judged property owns, so its run pays only for them.
const MODEL_CASES = {
    P1: 'money-float-tax,money-discount-decimal,money-cents-helpers,api-error-leak,api-error-contract',
    P2: 'money-float-tax,api-error-leak,api-only-general-bug',
};

const MUTATIONS = [
    {
        property: 'P1',
        patch: 'P1-instructions-dropped.patch',
        break: "the agent's instructions never reach its prompt",
        checks: [{ jest: [SPEC.provider] }, { model: MODEL_CASES.P1 }],
    },
    {
        property: 'P2',
        patch: 'P2-lane-focus-dropped.patch',
        break: "no lane focus: the verifier no longer drops findings outside the agent's instructions",
        checks: [{ jest: [SPEC.provider] }, { model: MODEL_CASES.P2 }],
    },
    {
        property: 'P3',
        patch: 'P3-include-globs-ignored.patch',
        break: 'include globs are not applied: an agent gets every changed file',
        checks: [{ jest: [SPEC.scope, SPEC.orchestrator] }, { fake: true }],
    },
    {
        property: 'P4',
        patch: 'P4-ignored-files-unreached.patch',
        break: 'an explicit include glob no longer reaches an ignored file',
        checks: [
            { jest: [SPEC.scope, SPEC.orchestrator, SPEC.fetch, SPEC.stage] },
            { fake: true },
        ],
    },
    {
        property: 'P5',
        patch: 'P5-floor-and-cap-after-dedup.patch',
        break: "the agent's severity floor and comment cap run after dedup instead of before",
        checks: [{ jest: [SPEC.stage] }],
    },
    {
        property: 'P6',
        patch: 'P6-any-file-quotable.patch',
        break: 'the quote gate takes a quote from any repository file',
        checks: [{ jest: [SPEC.quote] }],
    },
    {
        property: 'P7',
        patch: 'P7-disabled-agent-runs.patch',
        break: 'enabled:false is ignored where the stage and the dispatch read it',
        checks: [{ jest: [SPEC.scope, SPEC.stage] }, { fake: true }],
    },
    {
        property: 'P7',
        patch: 'P7-directory-override-ignored.patch',
        break: "a directory's agent with an inherited id is added beside it instead of replacing it (enabled:false at a directory no longer turns it off)",
        checks: [{ jest: [SPEC.cascade] }],
    },
];

const git = (...argv) =>
    spawnSync('git', argv, { cwd: ROOT, encoding: 'utf8' });
// Asynchronous: the scripted model is served from this process, so a check
// that blocked the event loop would never get its answers.
function run(cmd, argv, env = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, argv, {
            cwd: ROOT,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}
const touched = (patch) =>
    [...fs.readFileSync(patch, 'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(
        (m) => m[1],
    );

async function jest(specs) {
    const r = await run(
        path.join(ROOT, 'node_modules/.bin/jest'),
        [
            '--config',
            'jest.config.ts',
            '--forceExit',
            '--no-coverage',
            '--runTestsByPath',
            ...specs,
        ],
        { API_NODE_ENV: 'test' },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    const failed = [...out.matchAll(/^\s+● (.+)$/gm)].map((m) =>
        m[1].replace(/\s+/g, ' ').trim(),
    );
    const tally = (out.match(/^Tests:.*$/m) || ['Tests: ?'])[0];
    return {
        red: r.status !== 0,
        measured: true,
        summary: `${tally}${failed.length ? ` — ${[...new Set(failed)].slice(0, 3).join(' | ')}` : ''}`,
    };
}

async function evalGate(model, cases, env) {
    const argv = [
        'evals/custom-agents/run.js',
        `--model=${model}`,
        '--gate',
        ...(cases ? [`--cases=${cases}`] : []),
    ];
    const r = await run('node', argv, env);
    const out = `${r.stdout}\n${r.stderr}`;
    const lines = out
        .split('\n')
        .filter((l) =>
            /GATE FAILED|not measured|^custom-agents:|^\s+P\d:/.test(l),
        );
    if (r.status === 2)
        return {
            red: false,
            measured: false,
            summary:
                lines.find((l) => /not measured/.test(l)) || 'not measured',
        };
    return { red: r.status === 1, measured: true, summary: lines.join(' · ') };
}

async function main() {
    const only = args.only ? String(args.only).split(',') : null;
    const mutations = MUTATIONS.filter(
        (m) => !only || only.includes(m.property),
    );
    const server = await startFakeLlmServer();
    const fakeEnv = {
        EVAL_FAKE_LLM_URL: server.url,
        EVAL_FAKE_LLM_KEY: 'fake',
        API_TRUST_JSON_SCHEMA_BASE_URLS: new URL(server.url).host,
    };
    const rows = [];
    let broken = false;
    try {
        for (const m of mutations) {
            const patch = path.join(__dirname, m.patch);
            const files = touched(patch);
            if (git('diff', '--quiet', '--', ...files).status !== 0) {
                console.error(
                    `refused: ${files.join(', ')} has uncommitted changes; ${m.patch} needs a clean file`,
                );
                return 2;
            }
            const applied = git('apply', patch);
            if (applied.status !== 0) {
                console.error(
                    `${m.patch} does not apply: ${applied.stderr.trim()}`,
                );
                return 2;
            }
            // An interrupted run still leaves production's code as it found it.
            const onSignal = () => {
                git('apply', '-R', patch);
                process.exit(2);
            };
            process.once('SIGINT', onSignal);
            process.once('SIGTERM', onSignal);
            try {
                for (const check of m.checks) {
                    let name;
                    let outcome;
                    if (check.jest) {
                        name = `jest ${check.jest.map((s) => path.basename(s)).join(', ')}`;
                        outcome = await jest(check.jest);
                    } else if (check.fake) {
                        name = 'eval --model=eval-fake --gate';
                        outcome = await evalGate('eval-fake', null, fakeEnv);
                    } else if (args['skip-model']) {
                        name = `eval --model=${MODEL} --gate`;
                        outcome = {
                            red: false,
                            measured: false,
                            summary: 'skipped (--skip-model)',
                        };
                    } else {
                        name = `eval --model=${MODEL} --gate --cases=…`;
                        outcome = await evalGate(MODEL, check.model, {});
                    }
                    rows.push({
                        property: m.property,
                        patch: m.patch,
                        check: name,
                        ...outcome,
                    });
                    console.log(
                        `${m.property} ${m.patch} :: ${name} -> ${outcome.measured ? (outcome.red ? 'RED' : 'GREEN') : 'NOT MEASURED'} :: ${outcome.summary}`,
                    );
                }
            } finally {
                process.removeListener('SIGINT', onSignal);
                process.removeListener('SIGTERM', onSignal);
                const reverted = git('apply', '-R', patch);
                if (
                    reverted.status !== 0 ||
                    git('diff', '--quiet', '--', ...files).status !== 0
                ) {
                    console.error(
                        `${m.patch}: the tree was not restored (${reverted.stderr.trim()})`,
                    );
                    broken = true;
                }
            }
            if (broken) return 2;
        }
    } finally {
        await server.close();
    }

    console.log('\n| property | break (patch) | check | result |');
    console.log('|---|---|---|---|');
    for (const r of rows)
        console.log(
            `| ${r.property} | ${r.patch} | ${r.check} | ${r.measured ? (r.red ? 'red' : '**green: not falsified**') : 'not measured'} |`,
        );
    console.log(`\ntree restored after every patch: ${broken ? 'NO' : 'yes'}`);
    if (rows.some((r) => r.measured && !r.red)) return 1;
    if (!rows.length) {
        console.error('not measured: no mutation selected');
        return 2;
    }
    const unmeasured = rows.filter((r) => !r.measured).length;
    if (unmeasured / rows.length > 0.05) {
        console.error(
            `not measured: ${unmeasured} of ${rows.length} checks (more than 5%)`,
        );
        return 2;
    }
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(2);
    });
