#!/usr/bin/env node
// pnpm eval:new <name> — a new eval that already follows evals/AGENTS.md: the
// README header, cases that each say what they check (with a control pair), a
// catalog the quality panel reads, and a runner that writes the shared result
// (evals/shared/eval-result.js), counts tokens and exits 0/1/2. What is left is
// the part only the author knows: the question, the cases, and the call into
// the engine's real entry point.
//
//   node evals/shared/new-eval.js <name> [--dir=<evals dir>]
const fs = require('fs');
const path = require('path');

const README = (name) => `# ${name}

> - **Answers:** TODO: the one question this eval answers, ending in a question mark?
> - **Runs:** on demand (\`node evals/${name}/run.js\`); add it to \`evals/wiring-smoke.js\` to run on every engine PR.
> - **Run it:** \`node evals/${name}/run.js --model=eval-fake\`
> - **Gate:** \`--gate\` fails below the floor in \`evals/${name}/targets.json\`.
> - **Cost:** real model calls per case; none under the scripted model.

TODO: what the eval drives (the engine's real entry point), where its cases come
from, and what a case counts as right.
`;

const CASES = [
    {
        id: 'control-must-pass',
        checks: 'TODO: Flags the problem in a case built to contain it (control: must pass)',
        input: {},
        expected: { items: ['TODO: what must be found'] },
    },
    {
        id: 'control-must-not-flag',
        checks: 'TODO: Stays quiet on a case built without the problem (control: nothing to find)',
        input: {},
        expected: { items: [] },
    },
];

const CATALOG = `// The cases this eval runs (cases.json), each with what it checks.
const cases = require('./cases.json');

function catalog() {
    return cases.map((c) => ({ id: c.id, checks: c.checks }));
}

module.exports = { catalog };
`;

const TARGETS = {
    __doc: ['Floors per model. Calibrate from two full runs of one commit (evals/AGENTS.md, "Floors and judges"); never copy these numbers elsewhere.'],
    models: {},
};

const RUN = (name) => `#!/usr/bin/env node
// ${name}: TODO one line on what this drives.
//
//   node evals/${name}/run.js [--model=<id>] [--gate] [--output=<result.json>] [--limit=N]
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/AGENTS.md).
const fs = require('fs');
const path = require('path');
const { applyModelEnv } = require('../shared/tier0-models');
const { countTokens, tokensUsed } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const MODEL = args.model || 'eval-fake';
const cases = require('./cases.json').slice(0, args.limit ? Number(args.limit) : undefined);
const floor = (require('./targets.json').models[MODEL] || {}).floor ?? null;

// TODO: drive the engine's real entry point for one case and return what it
// produced. Never a hand-written stub of an engine service (evals/AGENTS.md).
async function runCase(_testCase) {
    throw new Error('not wired: runCase must call the engine');
}

// TODO: score one case: which expected items came out right.
function score(testCase, output) {
    const detail = testCase.expected.items.map((what) => ({ what, ok: Boolean(output && output.includes && output.includes(what)) }));
    return { hits: detail.filter((d) => d.ok).length, total: detail.length, detail };
}

async function main() {
    applyModelEnv(MODEL);
    countTokens();
    const results = [];
    let errored = 0;
    for (const testCase of cases) {
        try {
            results.push({ id: testCase.id, checks: testCase.checks, ...score(testCase, await runCase(testCase)) });
        } catch (error) {
            errored += 1;
            console.error(\`  \${testCase.id}: \${String(error.message || error).slice(0, 200)}\`);
            results.push({ id: testCase.id, checks: testCase.checks, hits: 0, total: 0, unmeasured: true });
        }
    }
    const hits = results.reduce((n, r) => n + r.hits, 0);
    const total = results.reduce((n, r) => n + r.total, 0);
    const result = {
        eval: '${name}',
        question: evalQuestion('evals/${name}'),
        model: MODEL,
        runs: 1,
        metric: { name: 'TODO metric name', value: total ? hits / total : null, floor, baseline: null },
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: cases.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, \`\${JSON.stringify(result, null, 2)}\\n\`);
    }
    console.log(\`\${result.eval}: \${hits}/\${total} · \${errored} of \${cases.length} cases did not measure\`);
    if (errored > cases.length * 0.05) {
        console.error(\`not measured: \${errored} of \${cases.length} cases failed to run (see above)\`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(\`not measured: the result breaks the shared shape — \${problems.join('; ')}\`);
        return 2;
    }
    if (args.gate && floor !== null && result.metric.value < floor) return 1;
    return 0;
}

main().then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(2); });
`;

function scaffold(name, dir) {
    if (!/^[a-z][a-z0-9-]*$/.test(name || '')) throw new Error('usage: pnpm eval:new <name> (lowercase, digits and dashes)');
    const target = path.join(dir, name);
    if (fs.existsSync(target)) throw new Error(`${target} already exists`);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'README.md'), README(name));
    fs.writeFileSync(path.join(target, 'cases.json'), `${JSON.stringify(CASES, null, 4)}\n`);
    fs.writeFileSync(path.join(target, 'catalog.js'), CATALOG);
    fs.writeFileSync(path.join(target, 'targets.json'), `${JSON.stringify(TARGETS, null, 4)}\n`);
    fs.writeFileSync(path.join(target, 'run.js'), RUN(name));
    return target;
}

function main() {
    const name = process.argv[2];
    const dirArg = process.argv.find((a) => a.startsWith('--dir='));
    const dir = dirArg ? dirArg.slice('--dir='.length) : path.join(__dirname, '..');
    let target;
    try {
        target = scaffold(name, dir);
    } catch (error) {
        console.error(error.message);
        return 2;
    }
    console.log(`Created ${path.relative(process.cwd(), target)}. To finish it:
  1. README.md: the question in **Answers**, and the rest of the header.
  2. cases.json: your cases, each with a "checks" sentence; keep a control pair.
  3. run.js: runCase() calls the engine's real entry point; score() says what a case got right.
  4. evals/stages.js: name the stage it covers (eval: 'evals/${name}'), so it reaches the panel.
  5. evals/wiring-smoke.js: a step with model: true running it on --model=eval-fake.
  6. Calibrate the floor in targets.json from two full runs (evals/AGENTS.md).
  7. To measure it every night it changes: add it to evals/nightly-evals.js (its stage gets nightly: 'shared').
evals/stage-signals.spec.ts fails until 4 and 5 agree, and every catalog is valid.`);
    return 0;
}

if (require.main === module) process.exit(main());

module.exports = { scaffold };
