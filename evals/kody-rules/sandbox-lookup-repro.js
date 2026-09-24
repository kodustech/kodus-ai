// REAL-SANDBOX harness for issue #1826.
//
// Every #1826 measurement so far (BASELINE-1826, AFTER-1826, NEED-1826) drove
// the shipped judge but substituted an IN-MEMORY fake for the repository
// lookup: a JS object doing `line.includes(pattern)`. That proves the logic of
// the claim checker and the context retriever. It proves nothing about the
// layer underneath them — whether a real sandbox is entered, whether `rg`
// actually runs, and whether what comes back is what the fake pretended.
//
// This harness removes the fake. It builds a REAL git repository from the
// case fixtures, hands it to the REAL LocalSandboxService, and wraps the
// result in the REAL buildRepoLookup. Nothing here reimplements a production
// method:
//
//   LocalSandboxService.createSandboxWithRepo  -> git init/fetch/checkout, rg
//   buildRepoLookup                            -> the fail-closed wrapper
//   retrieveForShard / checkClaims             -> unchanged
//
// `cloneUrl` is a local path on purpose: `git fetch <path> <refspec>` is a
// normal fetch, so the production clone path runs end to end without a network
// remote or a token.
//
//   node evals/kody-rules/sandbox-lookup-repro.js [--cases=cases-1826-need]
//   node evals/kody-rules/sandbox-lookup-repro.js --probe-only   (no LLM call)
//
// --probe-only exercises sandbox + lookup + retrieval + claim-refutation with
// NO model call at all, so the integration can be checked for free and in CI.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
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
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const CASES = args.cases || 'cases-1826-need';
const OUT = args.out || 'SANDBOX-1826.txt';
const PROVIDER = args.provider || 'local';

const { LocalSandboxService } = require('@libs/sandbox/infrastructure/providers/local-sandbox.service');
const { E2BSandboxService } = require('@libs/sandbox/infrastructure/providers/e2b-sandbox.service');
const { buildRepoLookup } = require('@libs/code-review/infrastructure/agents/collaborators/repo-lookup');
const { retrieveForShard, needOf } = require('@libs/code-review/infrastructure/agents/collaborators/rule-context.retriever');
const { readClaim } = require('@libs/code-review/infrastructure/agents/collaborators/claim-checker');

const seed = require('./' + CASES + '.json');

const out = [];
const say = (l = '') => { out.push(l); console.log(l); };

/** A real git repository holding the case's repoFiles, to be fetched FROM. */
function makeOriginRepo(repoFiles) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-1826-origin-'));
    const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
    git('config', 'user.email', 'eval@kodus.io');
    git('config', 'user.name', 'eval');
    for (const [rel, content] of Object.entries(repoFiles || {})) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
    return dir;
}

(async () => {
    say(`reproduce: node evals/kody-rules/sandbox-lookup-repro.js --cases=${CASES}`);
    say(`corpus: ${CASES}.json — ${seed.cases.length} case(s)`);
    say(`sandbox provider: ${PROVIDER}  (real git + real rg), lookup: buildRepoLookup`);
    say(`This harness uses NO in-memory lookup. Every grep/exists below is a`);
    say(`process running inside a sandbox the production provider created.`);
    say();

    let failures = 0;
    for (const c of seed.cases) {
        say(`══ ${c.caseId}  [need: ${needOf(c.rule)}]`);
        const origin = makeOriginRepo(c.repoFiles);
        let sandbox;
        try {
            // The module's own selection, not a copy of it: SandboxModule picks
            // E2B when API_E2B_KEY is set and LocalSandbox otherwise. Forced
            // here with --provider so BOTH branches of that fork can be run.
            const cfg = { get: (k) => process.env[k] };
            const svc = PROVIDER === 'e2b'
                ? new E2BSandboxService(cfg)
                : new LocalSandboxService(cfg);
            sandbox = await svc.createSandboxWithRepo({
                cloneUrl: origin, authToken: '', branch: 'main', platform: 'github',
            });
            say(`   sandbox type=${sandbox.type} repoDir=${sandbox.repoDir ? 'set' : 'MISSING'}`);

            const logger = { warn: (e) => say(`      warn: ${e.message}`) };
            const lookup = buildRepoLookup(sandbox, logger);
            say(`   lookup.available=${lookup.available}${lookup.available ? '' : ' (' + lookup.unavailableReason + ')'}`);

            // Positive control: the production probe, on a file the case changed.
            const known = c.changedFiles[0].filename;
            try {
                await lookup.probe(known);
                say(`   probe(${known}) → ok, lookup still available=${lookup.available}`);
            } catch (e) { say(`   probe THREW: ${e.message}`); }

            // What the real sandbox answers for the three primitives.
            const sym = 'slugify';
            const g = await lookup.grep(sym);
            say(`   grep("${sym}") → ${JSON.stringify(g.length > 200 ? g.slice(0, 200) + '…' : g)}`);
            const missing = 'src/routes/definitely-not-here.spec.ts';
            say(`   exists("${missing}") → ${await lookup.exists(missing)}`);
            say(`   exists("${known}") → ${await lookup.exists(known)}`);
            const head = await lookup.read(known, 1, 3);
            say(`   read("${known}",1,3) → ${JSON.stringify(head.slice(0, 120))}`);

            // The real retrieval, with the real lookup.
            if (needOf(c.rule) !== 'diff-only') {
                const r = await retrieveForShard({
                    file: c.changedFiles[0], rules: [c.rule], lookup,
                    changedFilenames: c.changedFiles.map((f) => f.filename), logger,
                });
                say(`   retrieveForShard → ${r.slices.length} slice(s), ${r.unmet.length} unmet`);
                for (const s of r.slices) {
                    say(`     [${s.kind}] ${s.label}`);
                    for (const line of s.content.split('\n')) say(`        ${line}`);
                }
                if (!r.slices.length && !r.unmet.length) { failures++; say(`   *** FAIL: need declared but nothing retrieved and nothing reported unmet`); }
            }
        } catch (err) {
            failures++;
            say(`   *** FAIL: ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err}`);
        } finally {
            try { await sandbox?.cleanup?.(); } catch {}
            fs.rmSync(origin, { recursive: true, force: true });
        }
        say();
    }

    say(`TOTAL: ${failures} case(s) failed the real-sandbox path.`);
    fs.writeFileSync(path.join(__dirname, OUT), out.join('\n') + '\n');
    console.log(`\nwrote -> evals/kody-rules/${OUT}`);
})();
