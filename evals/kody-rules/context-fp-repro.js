// REPRO + REGRESSION harness for issue #1826: a Kody Rule is judged as if the
// diff were the whole world, so a claim whose truth lives outside the hunk
// ("this import is unused", "the test is missing", "this helper already
// exists") is asserted blind and published.
//
//   node evals/kody-rules/context-fp-repro.js [--cases=cases-1826] [--model=gpt-5.4-mini]
//   node evals/kody-rules/context-fp-repro.js --reps=3 --out=AFTER-1826.txt
//
// Like detector-fp-repro.js it drives the SHIPPED engine — `judgeKodyRulesSharded`
// with the production `runJudge` closure — so the same command run before and
// after a change measures the change rather than a model of it. In particular
// the model call goes through `LLM.run`, which is the path that emits the
// observability usage span; a bare `generateText` here would spend tokens no
// billing dataset ever sees.
//
// The corpus is NEGATIVE: every case's correct published count is 0. That only
// means something alongside the positive control, which is a separate command
// and is NOT re-run here:
//
//   node evals/kody-rules/detector-fp-repro.js \
//     --rules=detectors-positive-control --corpus=github-cases --judge
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (module, filename) {
    const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2021', sourcefile: filename,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    });
    module._compile(code, filename);
};
require('tsconfig-paths/register');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
if (process.env.HOME) dotenv.config({ path: path.join(process.env.HOME, '.kodus-dev/config'), override: true });
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const CASES = args.cases || 'cases-1826';
const MODELKEY = args.model || 'gpt-5.4-mini';
const CONC = +(args.conc || 2);
const REPS = +(args.reps || 1);
const OUT = args.out || 'BASELINE-1826.txt';

const { judgeKodyRulesSharded, shardViolationsWireSchema, ruleAppliesToFile } = require('@libs/code-review/infrastructure/agents/collaborators/kody-rules-sharded.judge');
const { checkClaims } = require('@libs/code-review/infrastructure/agents/collaborators/claim-checker');
const { retrieveForShard, needOf } = require('@libs/code-review/infrastructure/agents/collaborators/rule-context.retriever');
const { LLM } = require('@libs/llm/llm');
const { applyModelEnv } = require('../shared/tier0-models');

const seed = require('./' + CASES + '.json');
const cases = seed.cases;

/**
 * The production runJudge, minus the org's BYOK slot (there is none in an eval,
 * so `LLM.run` falls through to the env-configured managed model that
 * applyModelEnv just pointed at). Everything else is the closure
 * kody-rules-agent.provider.ts builds: the same wire schema, the same envelope
 * recovery, and the same billing span, since `LLM.run` is what opens it.
 */
const runJudge = async ({ system, user, filename }) => {
    const parsed = await LLM.run({
        schema: shardViolationsWireSchema,
        recoverEnvelopeShape: true,
        system,
        user,
        runName: 'kody-rules-1826-repro.shard',
        attrs: { agentName: 'kody-rules-1826-repro', ...(filename ? { file: filename } : {}) },
    });
    return parsed?.violations ?? [];
};

/**
 * A RepoLookup over the case's own `repoFiles` — the synthetic repository each
 * case ships so a claim can actually be checked. Same contract as the real one
 * (`buildRepoLookup`): grep answers `path:line:content` lines or the literal
 * "No matches found.", and nothing ever answers with silence.
 */
function lookupFromRepoFiles(repoFiles) {
    const files = repoFiles || {};
    return {
        available: true,
        unavailableReason: '',
        async grep(pattern) {
            const hits = [];
            for (const [file, content] of Object.entries(files)) {
                String(content).split('\n').forEach((line, i) => {
                    if (line.includes(pattern)) hits.push(`${file}:${i + 1}:${line}`);
                });
            }
            return hits.length ? hits.join('\n') : 'No matches found.';
        },
        async read(file, start, end) {
            const content = files[file];
            if (content === undefined) return '';
            return String(content).split('\n').slice(Math.max(0, start - 1), end).join('\n');
        },
        async exists(file) {
            return Object.prototype.hasOwnProperty.call(files, file);
        },
        async probe() {},
    };
}

/**
 * The provider's own sequence, minus NestJS: retrieve the declared context per
 * file, judge, then refute each finding's claim. Measuring only the judge would
 * measure the prompt and none of the checks this issue actually added.
 */
async function runCase(c) {
    const logger = { warn: (e) => out.push(`      warn: ${e.message}`) };
    const lookup = lookupFromRepoFiles(c.repoFiles);
    const changedFilenames = c.changedFiles.map((f) => f.filename);

    const contextSlices = new Map();
    const unmetRules = new Map();
    if (needOf(c.rule) !== 'diff-only') {
        for (const file of c.changedFiles) {
            if (!ruleAppliesToFile(file.filename, c.rule.path)) continue;
            const retrieved = await retrieveForShard({
                file, rules: [c.rule], lookup, changedFilenames, logger,
            });
            if (retrieved.slices.length) contextSlices.set(file.filename, retrieved.slices);
            if (retrieved.unmet.length) {
                unmetRules.set(file.filename, new Set(retrieved.unmet.map((r) => r.uuid)));
            }
        }
    }

    const result = await judgeKodyRulesSharded({
        changedFiles: c.changedFiles,
        rules: [c.rule],
        runJudge,
        prTitle: c.prTitle,
        prBody: c.prBody,
        concurrency: CONC,
        logger,
        contextSlices,
        unmetRules,
    });

    const checked = await checkClaims({
        violations: result.violations,
        changedFiles: c.changedFiles,
        lookup,
        logger,
    });

    return { ...result, violations: checked.kept, dropped: checked.dropped, judged: result.violations.length };
}

const out = [];
const say = (line = '') => { out.push(line); console.log(line); };

(async () => {
    applyModelEnv(MODELKEY);

    say(`reproduce: node evals/kody-rules/context-fp-repro.js --model=${MODELKEY} --reps=${REPS} --out=${OUT}`);
    say(`corpus: ${CASES}.json — ${cases.length} case(s), ${REPS} replicate(s)`);
    say(`model:  ${MODELKEY}`);
    say(`Every case's CORRECT published count is 0. A non-zero count is a rule`);
    say(`firing on a claim the diff window cannot support.`);
    say();

    let undue = 0;
    let total = 0;
    for (const c of cases) {
        say(`══ ${c.caseId}  [claim: ${c.claimFamily}]`);
        say(`   rule: ${c.rule.title}`);
        say(`   file: ${c.changedFiles.map((f) => f.filename).join(', ')}`);
        say(`   why 0 is correct: ${c.why}`);
        const perRep = [];
        for (let rep = 1; rep <= REPS; rep++) {
            let result;
            try {
                result = await runCase(c);
            } catch (err) {
                say(`   rep ${rep}: ERRORED — ${err instanceof Error ? err.message : String(err)}`);
                perRep.push('err');
                continue;
            }
            // Zero findings because every shard failed is NOT a clean run. Left
            // uncounted it would read as a perfect score on this corpus, which
            // is exactly the silent degradation the escalation in the rules
            // provider exists to prevent (#1523/#1526).
            if (result.shardsRun > 0 && result.shardsErrored === result.shardsRun) {
                say(`   rep ${rep}: ALL ${result.shardsRun} shard(s) ERRORED — not a measurement, see the warn above`);
                perRep.push('err');
                continue;
            }
            const published = result.violations;
            perRep.push(published.length);
            total++;
            if (published.length > c.expectedPublished) undue++;
            say(`   rep ${rep}: published ${published.length} (expected ${c.expectedPublished})  judged ${result.judged}, claim-check dropped ${result.dropped.length}  shards ${result.shardsRun} run / ${result.shardsErrored} errored`);
            for (const v of published) {
                say(`      ${v.relevantFile ?? '(PR)'}:${v.relevantLinesStart ?? '-'}  ${String(v.oneSentenceSummary || '').slice(0, 110)}`);
            }
            for (const d of result.dropped) {
                say(`      dropped: ${d.reason}`);
            }
        }
        say(`   → per-replicate published: [${perRep.join(', ')}]`);
        say();
    }

    const expected = cases.length * REPS;
    say(`TOTAL: ${undue} of ${total} case-runs published a comment that should not exist.`);
    if (total < expected) {
        say(`WARNING: only ${total} of ${expected} case-runs produced a measurement; the rest errored.`);
    }

    const outPath = path.join(__dirname, OUT);
    fs.writeFileSync(outPath, out.join('\n') + '\n');
    console.log(`\nwrote -> ${path.relative(process.cwd(), outPath)}`);
})();
