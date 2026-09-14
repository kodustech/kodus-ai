// Provider conformance probe for the repository lookup (issue #1826).
//
// buildRepoLookup sits on top of RemoteCommands and is written to a contract:
// `exists` returns false ONLY when the parent listed successfully and the path
// was not in it, and any transport failure PROPAGATES, because "I could not
// check" must never be reported as "it is not there".
//
// Nothing verifies that the providers honour that contract. They are two
// separate implementations — E2B runs `find` in a remote shell and returns
// stdout, LocalSandbox runs `find` through execFile after an lstat guard — and
// production uses E2B while self-hosted uses LocalSandbox. A divergence here
// is a difference in what the customer's review does, per deployment.
//
// This asks BOTH the same questions against the same public repository and
// prints the answers side by side.
//
//   node evals/kody-rules/lookup-conformance.js --provider=local
//   node evals/kody-rules/lookup-conformance.js --provider=e2b
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
const PROVIDER = args.provider || 'local';
const REPO = args.repo || 'https://github.com/octocat/Hello-World.git';
const BRANCH = args.branch || 'master';

const { LocalSandboxService } = require('@libs/sandbox/infrastructure/providers/local-sandbox.service');
const { E2BSandboxService } = require('@libs/sandbox/infrastructure/providers/e2b-sandbox.service');
const { buildRepoLookup, grepIsEmpty } = require('@libs/code-review/infrastructure/agents/collaborators/repo-lookup');

const out = [];
const say = (l = '') => { out.push(l); console.log(l); };

/** Run one probe, reporting THROW as a distinct outcome from a value. */
async function probe(label, fn) {
    try {
        const v = await fn();
        const shown = typeof v === 'string'
            ? JSON.stringify(v.length > 160 ? v.slice(0, 160) + '…' : v)
            : String(v);
        say(`  ${label.padEnd(52)} -> ${shown}`);
        return { ok: true, value: v };
    } catch (err) {
        say(`  ${label.padEnd(52)} -> THREW ${err instanceof Error ? err.message.split('\n')[0].slice(0, 110) : err}`);
        return { ok: false, err };
    }
}

(async () => {
    say(`provider: ${PROVIDER}   repo: ${REPO}#${BRANCH}`);
    say();
    const cfg = { get: (k) => process.env[k] };
    const svc = PROVIDER === 'e2b' ? new E2BSandboxService(cfg) : new LocalSandboxService(cfg);

    let sandbox;
    try {
        sandbox = await svc.createSandboxWithRepo({
            cloneUrl: REPO, authToken: '', branch: BRANCH, platform: 'github',
        });
        say(`sandbox.type = ${sandbox.type}`);
        const lookup = buildRepoLookup(sandbox, { warn: (e) => say(`  warn: ${e.message}`) });
        say(`lookup.available = ${lookup.available}`);
        say();

        say('THE CONTRACT: exists() must return false for a real absence and THROW');
        say('when it could not look. A parent directory that does not exist is a');
        say('real absence, not a failure — it is the ordinary case for a sibling');
        say('candidate like <dir>/__tests__/<name>.');
        say();
        const existing = await probe('exists("README")            [file that exists]', () => lookup.exists('README'));
        const absentSameDir = await probe('exists("nope.txt")          [absent, parent EXISTS]', () => lookup.exists('nope.txt'));
        const missingParent = await probe('exists("__tests__/x.ts")    [absent, parent MISSING]', () => lookup.exists('__tests__/x.ts'));
        const deepMissing = await probe('exists("a/b/c/d.ts")        [absent, deep missing]', () => lookup.exists('a/b/c/d.ts'));
        say();
        const hit = await probe('grep("Hello")               [expect matches]', () => lookup.grep('Hello'));
        const miss = await probe('grep("zzz-no-such-symbol")  [expect no matches]', () => lookup.grep('zzz-no-such-symbol'));
        say();
        await probe('read("README", 1, 3)', () => lookup.read('README', 1, 3));
        const absent = await probe('read("nope.txt", 1, 3)      [absent file]', () => lookup.read('nope.txt', 1, 3));
        say();

        // ── the contract, as pass/fail rather than as output to be eyeballed ──
        say('CONTRACT CHECKS');
        const checks = [
            ['exists() is true for a file that is there', existing.ok && existing.value === true],
            ['exists() is false when the parent lists and the file is absent', absentSameDir.ok && absentSameDir.value === false],
            ['exists() is false when the parent directory is missing', missingParent.ok && missingParent.value === false],
            ['exists() is false for a deeply absent path', deepMissing.ok && deepMissing.value === false],
            ['grep() returns repo-relative paths, never absolute', hit.ok && !hit.value.includes('/home/user/repo') && !hit.value.includes('/var/folders')],
            // The two providers word "no occurrence" differently. That is fine
            // ONLY because every consumer goes through grepIsEmpty; the point of
            // this check is that the shared helper accepts whichever this
            // provider chose, so no caller has to know which one it is talking to.
            ['grep() empty answer is recognised by grepIsEmpty', miss.ok && grepIsEmpty(miss.value)],
            ['grep() non-empty answer is NOT recognised as empty', hit.ok && !grepIsEmpty(hit.value)],
            ['read() of an absent file raises rather than answering empty', !absent.ok],
        ];
        let failed = 0;
        for (const [label, ok] of checks) {
            if (!ok) failed++;
            say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
        }
        say();
        say(`RESULT: ${failed === 0 ? 'contract honoured' : `${failed} contract violation(s)`} on provider "${PROVIDER}"`);
        process.exitCode = failed === 0 ? 0 : 1;
    } catch (err) {
        say(`SETUP FAILED: ${err instanceof Error ? err.stack.split('\n').slice(0, 4).join('\n  ') : err}`);
    } finally {
        try { await sandbox?.cleanup?.(); } catch {}
    }

    fs.writeFileSync(path.join(__dirname, `LOOKUP-CONFORMANCE-${PROVIDER}.txt`), out.join('\n') + '\n');
    console.log(`\nwrote -> evals/kody-rules/LOOKUP-CONFORMANCE-${PROVIDER}.txt`);
})();
