// Issue #1826 — PROOF, on production code, that sibling-file retrieval reports
// a file that demonstrably exists as missing.
//
// Nothing here is a fixture or a stub. It clones the real public kodus-ai
// repository into a real sandbox created by the production provider, then calls
// the production functions in the production order:
//
//   <provider>.createSandboxWithRepo()   the pipeline's own sandbox
//   buildRepoLookup()                    the pipeline's own lookup wrapper
//   retrieveForShard()                   the function the Kody Rules judge calls
//
// The target pair is real and committed on main:
//   libs/.../call-graph.helper.ts   and   libs/.../call-graph.helper.spec.ts
//
// The spec file EXISTS. The proof reads it through the same sandbox first, so
// "it is there" is established by the sandbox itself and not asserted. Then it
// asks the production code whether it exists.
//
//   node evals/kody-rules/sibling-file-proof.js --provider=e2b
//   node evals/kody-rules/sibling-file-proof.js --provider=local
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (m, f) {
    const { code } = esbuild.transformSync(fs.readFileSync(f, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2021', sourcefile: f,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    });
    m._compile(code, f);
};
require('tsconfig-paths/register');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const PROVIDER = args.provider || 'e2b';
// Visible in the E2B dashboard's METADATA column. The review stage passes
// `sandboxMetadata: { stage: 'review' }` and the provider merges `prNumber` in
// front of it (e2b-sandbox.service.ts:236-239), which is why production rows
// read {"prNumber":"790","stage":"review"}. This run is tagged so it can be
// told apart from a real review at a glance.
const RUN_TAG = args.tag || `issue-1826-sibling-proof-${Date.now()}`;
const KEEP_MS = Number(args.keep || 0) * 1000;

const { LocalSandboxService } = require('@libs/sandbox/infrastructure/providers/local-sandbox.service');
const { E2BSandboxService } = require('@libs/sandbox/infrastructure/providers/e2b-sandbox.service');
const { buildRepoLookup } = require('@libs/code-review/infrastructure/agents/collaborators/repo-lookup');
const { retrieveForShard } = require('@libs/code-review/infrastructure/agents/collaborators/rule-context.retriever');

const DIR = 'libs/code-review/infrastructure/agents/collaborators';
const SOURCE = `${DIR}/call-graph.helper.ts`;
const SPEC = `${DIR}/call-graph.helper.spec.ts`;

const out = [];
const say = (l = '') => { out.push(l); console.log(l); };

(async () => {
    say(`provider: ${PROVIDER}`);
    say(`repo:     https://github.com/kodustech/kodus-ai.git (public), branch main`);
    say();

    const cfg = { get: (k) => process.env[k] };
    const svc = PROVIDER === 'e2b' ? new E2BSandboxService(cfg) : new LocalSandboxService(cfg);
    let sandbox;
    try {
        // NOTE ON FIDELITY: the review pipeline does not call the provider
        // directly — create-sandbox.stage.ts calls SandboxLeaseManager.acquire(),
        // which either creates (creator) or reconnects (joiner). Both converge on
        // the SAME RemoteCommands: buildE2BRemoteCommands, used at
        // e2b-sandbox.service.ts:794 (creator) and
        // sandbox-lease-manager.service.ts:835 (joiner). So the primitives probed
        // below are byte-identical to the ones any review path gets; only the
        // lease bookkeeping (Mongo) is skipped, and it does not touch grep/exists.
        sandbox = await svc.createSandboxWithRepo({
            cloneUrl: 'https://github.com/kodustech/kodus-ai.git',
            authToken: '', branch: 'main', platform: 'github',
            sandboxMetadata: {
                stage: 'review',
                prNumber: 'ISSUE-1826-PROOF',
                probe: RUN_TAG,
            },
        });
        say(`sandbox.type=${sandbox.type}  sandboxId=${sandbox.sandboxId}`);
        say(`metadata   = {"prNumber":"ISSUE-1826-PROOF","stage":"review","probe":"${RUN_TAG}"}`);
        const lookup = buildRepoLookup(sandbox, { warn: (e) => say(`  warn: ${e.message}`) });
        say(`lookup.available=${lookup.available}`);
        say();

        // ── STEP 1: let the sandbox itself establish that the spec is there ──
        say('STEP 1 — the SAME sandbox proves the spec file exists');
        const specHead = await lookup.read(SPEC, 1, 2);
        say(`  read("${SPEC}", 1, 2)`);
        for (const l of specHead.split('\n')) say(`    | ${l}`);
        const g = await lookup.grep('call-graph.helper.spec', DIR);
        say(`  grep("call-graph.helper.spec", "${DIR}") → ${JSON.stringify(g.slice(0, 160))}`);
        say();

        // ── STEP 2: ask the production lookup the same question ─────────────
        say('STEP 2 — the production lookup is asked whether that same file exists');
        try {
            const e = await lookup.exists(SPEC);
            say(`  lookup.exists("${SPEC}") → ${e}`);
            if (e !== true) say(`  *** WRONG: step 1 just read this file through this same sandbox.`);
        } catch (err) {
            say(`  lookup.exists(...) THREW ${err.message.split('\n')[0]}`);
            say(`  *** WRONG: a file that exists must answer true, not raise.`);
        }
        say();

        // ── STEP 3: the production retrieval the judge actually calls ────────
        say('STEP 3 — retrieveForShard(), the function the Kody Rules judge calls,');
        say('         for a rule declaring the sibling-file need on the source file');
        const rule = {
            uuid: 'proof-rule',
            title: 'Every new HTTP route handler ships with a test',
            rule: 'A new handler must be accompanied by a test file next to it.',
            path: '',
            contextNeed: { need: 'sibling-file', sourceHash: 'proof', source: 'author' },
        };
        const file = {
            filename: SOURCE,
            patch: '@@ -1,2 +1,3 @@\n context\n+export function addedByThisProof() {}\n',
            patchWithLinesStr: `## file: '${SOURCE}'\n\n@@ -1,2 +1,3 @@\n__new hunk__\n1  context\n2 +export function addedByThisProof() {}`,
        };
        const r = await retrieveForShard({
            file, rules: [rule], lookup,
            changedFilenames: [SOURCE],
            logger: { warn: (e) => say(`    warn: ${e.message.slice(0, 180)}`) },
        });
        say(`  → ${r.slices.length} slice(s), ${r.unmet.length} unmet`);
        for (const s of r.slices) {
            say(`  [${s.kind}] ${s.label}`);
            for (const l of s.content.split('\n')) say(`      ${l}`);
        }
        say();
        say('VERDICT');
        if (r.unmet.length) {
            say('  The rule is reported UNMET, so the judge never sees it: a Kody Rule');
            say('  the customer wrote is silently skipped on this provider.');
        } else if (r.slices.some((s) => s.content.includes(`${SPEC}: does not exist`))) {
            say(`  The judge is told "${SPEC}: does not exist".`);
            say('  Step 1 read that file through this very sandbox. The judge is being');
            say('  handed a false statement about the repository as retrieved evidence,');
            say('  which is the exact failure mode issue #1826 exists to remove.');
        } else {
            say('  Slice reports the sibling correctly.');
        }
    } catch (err) {
        say(`SETUP FAILED: ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n  ') : err}`);
    } finally {
        if (KEEP_MS > 0 && sandbox) {
            say();
            say(`holding the sandbox open for ${KEEP_MS / 1000}s so it can be seen in the`);
            say(`E2B dashboard — search METADATA for: ${RUN_TAG}`);
            await new Promise((r) => setTimeout(r, KEEP_MS));
        }
        try { await sandbox?.cleanup?.(); } catch {}
    }
    fs.writeFileSync(path.join(__dirname, `SIBLING-PROOF-${PROVIDER}.txt`), out.join('\n') + '\n');
    console.log(`\nwrote -> evals/kody-rules/SIBLING-PROOF-${PROVIDER}.txt`);
})();
