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
// A corpus may be negative (cases-1826: every correct count is 0) or positive
// (cases-1826-need: a rule that cannot fire without repository context). Both
// directions are scored, because step 2 can only DROP a finding and step 3 can
// only ADD one, so a harness blind to misses cannot tell them apart.
//
// The cases-1826 corpus is NEGATIVE: every case's correct published count is 0. That only
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
// --sandbox=local|e2b swaps the in-memory lookup for a REAL one: a real git
// repository built from the case's repoFiles, cloned by the production sandbox
// provider, wrapped by the production buildRepoLookup. Without it the harness
// keeps the fast fake, which is fine for prompt work and useless for anything
// that depends on how the repository actually answers.
const SANDBOX = args.sandbox || '';

const { judgeKodyRulesSharded, shardViolationsWireSchema, ruleAppliesToFile, FILE_CONTENT_MAX_LINES } = require('@libs/code-review/infrastructure/agents/collaborators/kody-rules-sharded.judge');
const { checkClaims } = require('@libs/code-review/infrastructure/agents/collaborators/claim-checker');
const { retrieveForShard, needOf } = require('@libs/code-review/infrastructure/agents/collaborators/rule-context.retriever');
const { LLM } = require('@libs/llm/llm');
const os = require('os');
const { execFileSync } = require('child_process');
const { LocalSandboxService } = require('@libs/sandbox/infrastructure/providers/local-sandbox.service');
const { E2BSandboxService } = require('@libs/sandbox/infrastructure/providers/e2b-sandbox.service');
const { buildRepoLookup } = require('@libs/code-review/infrastructure/agents/collaborators/repo-lookup');
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
 * A REAL repository lookup for one case: the fixture files become a real git
 * repository, the production provider clones it into a real sandbox, and the
 * production wrapper goes on top. `git fetch <local path>` is an ordinary
 * fetch, so the provider's clone path runs unchanged without a network remote.
 *
 * Returns a disposer alongside the lookup; the caller must call it.
 */
async function realLookupFor(repoFiles) {
    const files = Object.entries(repoFiles || {});
    const cfg = { get: (k) => process.env[k] };
    const cleanups = [];

    // LOCAL: `git fetch <path>` is an ordinary fetch, so a fixture repository on
    // disk drives the provider's real clone path.
    //
    // E2B: the clone runs INSIDE the remote sandbox, where a path on this
    // machine does not exist (git exits 128). So the sandbox is created from a
    // tiny public repo and the fixture is written into it through the sandbox's
    // own writeFile. Either way `rg` and `find` afterwards run on real files in
    // a real sandbox, which is the whole point.
    let sandbox;
    if (SANDBOX === 'e2b') {
        sandbox = await new E2BSandboxService(cfg).createSandboxWithRepo({
            cloneUrl: 'https://github.com/octocat/Hello-World.git',
            authToken: '', branch: 'master', platform: 'github',
            sandboxMetadata: { stage: 'review', probe: `kody-rules-eval-${CASES}` },
        });
        // Remove the seed repo's own files so the fixture is the whole world,
        // exactly as it is under the local provider.
        await sandbox.run(
            `cd ${sandbox.repoDir} && git rm -rq --ignore-unmatch . || true`,
        );
        for (const [rel, content] of files) {
            // ABSOLUTE on purpose. SandboxInstance.writeFile/readFile hand the
            // path straight to E2B's files API, which resolves against the
            // sandbox HOME (/home/user) — while grep/read/listDir in
            // buildE2BRemoteCommands resolve against REPO_DIR (/home/user/repo).
            // Writing "src/a.ts" therefore lands outside the repo and every
            // later lookup misses it.
            await sandbox.writeFile(`${sandbox.repoDir}/${rel}`, content);
        }
    } else {
        const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-eval-origin-'));
        cleanups.push(() => fs.rmSync(origin, { recursive: true, force: true }));
        const git = (...a) => execFileSync('git', ['-C', origin, ...a], { stdio: 'pipe' });
        execFileSync('git', ['init', '-q', '-b', 'main', origin], { stdio: 'pipe' });
        git('config', 'user.email', 'eval@kodus.io');
        git('config', 'user.name', 'eval');
        for (const [rel, content] of files) {
            const abs = path.join(origin, rel);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content);
        }
        git('add', '-A');
        git('commit', '-q', '-m', 'fixture');
        sandbox = await new LocalSandboxService(cfg).createSandboxWithRepo({
            cloneUrl: origin, authToken: '', branch: 'main', platform: 'github',
            sandboxMetadata: { stage: 'review', probe: `kody-rules-eval-${CASES}` },
        });
    }

    const lookup = buildRepoLookup(sandbox);
    // Positive control BEFORE measuring: if the fixture did not land, every
    // grep answers "nothing" and the run would score as a clean corpus.
    if (files.length) {
        const [firstPath] = files[0];
        const seen = await lookup.read(firstPath, 1, 1);
        if (!seen.trim()) {
            throw new Error(
                `fixture did not land in the ${SANDBOX} sandbox: ${firstPath} reads back empty`,
            );
        }
    }

    return {
        lookup,
        dispose: async () => {
            try { await sandbox.cleanup(); } catch {}
            for (const c of cleanups) c();
        },
    };
}

/**
 * The provider's own sequence, minus NestJS: retrieve the declared context per
 * file, judge, then refute each finding's claim. Measuring only the judge would
 * measure the prompt and none of the checks this issue actually added.
 */
async function runCase(c) {
    const logger = { warn: (e) => out.push(`      warn: ${e.message}`) };
    const real = SANDBOX ? await realLookupFor(c.repoFiles) : null;
    const lookup = real ? real.lookup : lookupFromRepoFiles(c.repoFiles);
    try {
    const changedFilenames = c.changedFiles.map((f) => f.filename);

    // Step 1 of the provider's sequence, and the one this harness used to skip:
    // the shard carries its file WHOLE, unconditionally, with no contextNeed
    // gate. Leaving it out measured a prompt production never sends — and it
    // is the block this issue is mostly about, so its absence biased every
    // full-file number taken before this.
    const fileContents = new Map();
    if (lookup.available) {
        for (const file of c.changedFiles) {
            if (file.status === 'added' || file.status === 'removed') continue;
            if (!ruleAppliesToFile(file.filename, c.rule.path)) continue;
            try {
                const text = await lookup.read(file.filename, 1, FILE_CONTENT_MAX_LINES);
                if (text && text.trim()) fileContents.set(file.filename, text);
            } catch (err) {
                logger.warn({ message: `could not read ${file.filename}: ${err.message}` });
            }
        }
    }

    const contextSlices = new Map();
    const unmetRules = new Map();
    if (needOf(c.rule) !== 'diff-only') {
        for (const file of c.changedFiles) {
            if (!ruleAppliesToFile(file.filename, c.rule.path)) continue;
            const retrieved = await retrieveForShard({
                file, rules: [c.rule], lookup, changedFilenames, logger,
                wholeFileAlreadyOnPage: fileContents.has(file.filename),
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
        fileContents,
    });

    const checked = await checkClaims({
        violations: result.violations,
        changedFiles: c.changedFiles,
        lookup,
        logger,
    });

    // What the customer actually SEES. agent-review.stage.ts collapses every
    // finding that carries the same ruleUuid into ONE comment ("Also found in:"
    // carries the rest), so a harness that counts raw findings scores a single
    // true violation reported per-line as eight false positives. Mirrored here
    // rather than imported: the pipeline's copy is a private method on a Nest
    // stage. `judged` and `kept` stay visible beside it so the collapse never
    // hides a real difference.
    const byRule = new Map();
    const unkeyed = [];
    for (const v of checked.kept) {
        if (!v.ruleUuid) { unkeyed.push(v); continue; }
        if (!byRule.has(v.ruleUuid)) byRule.set(v.ruleUuid, v);
    }
    const published = [...unkeyed, ...byRule.values()];

    return { ...result, violations: published, kept: checked.kept.length, dropped: checked.dropped, judged: result.violations.length,
        // What the harness actually PUT ON THE PAGE. Reported because the
        // absence of this number is what let the whole-file block go missing
        // from every measurement without anyone noticing.
        sentWholeFile: fileContents.size, sentSlices: contextSlices.size };
    } finally {
        await real?.dispose();
    }
}

const out = [];
const say = (line = '') => { out.push(line); console.log(line); };

(async () => {
    applyModelEnv(MODELKEY);

    say(`reproduce: node evals/kody-rules/context-fp-repro.js --model=${MODELKEY} --reps=${REPS} --out=${OUT}`);
    say(`corpus: ${CASES}.json — ${cases.length} case(s), ${REPS} replicate(s)`);
    say(`model:  ${MODELKEY}`);
    say(`lookup: ${SANDBOX ? `REAL sandbox (${SANDBOX}) via buildRepoLookup` : 'in-memory fake — grep is String.includes, exists is hasOwnProperty'}`);
    say(`Every case's CORRECT published count is 0. A non-zero count is a rule`);
    say(`firing on a claim the diff window cannot support.`);
    say();

    let undue = 0;
    // A negative corpus can only be failed by firing. A corpus whose correct
    // answer is non-zero is failed the OTHER way too, and a harness that counts
    // only one of them scores silence as a perfect run.
    let missed = 0;
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
            else if (published.length < c.expectedPublished) missed++;
            say(`   rep ${rep}: published ${published.length} (expected ${c.expectedPublished})  judged ${result.judged}, claim-check dropped ${result.dropped.length}, kept ${result.kept} → ${published.length} after rule-dedup  shards ${result.shardsRun} run / ${result.shardsErrored} errored  SENT whole-file:${result.sentWholeFile} slices:${result.sentSlices}`);
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
    say(`       ${missed} of ${total} case-runs FAILED TO PUBLISH one the rule should have caught.`);
    if (total < expected) {
        say(`WARNING: only ${total} of ${expected} case-runs produced a measurement; the rest errored.`);
    }

    const outPath = path.join(__dirname, OUT);
    fs.writeFileSync(outPath, out.join('\n') + '\n');
    console.log(`\nwrote -> ${path.relative(process.cwd(), outPath)}`);
})();
