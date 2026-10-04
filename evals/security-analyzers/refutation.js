// Can a deterministic tool refute what the reviewer asserts?
//
// Every measurement so far treated analyzers as a SOURCE of findings, where
// they turned out to be redundant. This tests the opposite direction: the
// reviewer states checkable facts — this package version has this advisory —
// and a database can say whether that is true.
//
// Dependencies are the sharpest case. Whether lodash@4.17.11 is named in an
// advisory is a lookup, not a judgement, so every claim the model makes here is
// verifiable against OSV. A claim OSV refutes is a false positive we could have
// suppressed before publishing it.
//
//   node evals/security-analyzers/refutation.js --limit 50
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
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
}));
const MODEL = args.model || 'claude-sonnet-4-6';
const LIMIT = Number(args.limit || 50);
const CONCURRENCY = Number(args.concurrency || 5);

const { applyModelEnv } = require('../shared/tier0-models');
const { buildEvalModel } = require('../shared/build-model');
const { buildCategoryReviewPrompt } = require(
    '../../libs/code-review/infrastructure/agents/prompts/review-prompt-blocks.ts',
);

/** Lockfile name -> OSV ecosystem. */
const ECOSYSTEM = {
    'package-lock.json': 'npm', 'yarn.lock': 'npm', 'pnpm-lock.yaml': 'npm',
    'npm-shrinkwrap.json': 'npm', 'requirements.txt': 'PyPI', 'poetry.lock': 'PyPI',
    'Pipfile.lock': 'PyPI', 'Gemfile.lock': 'RubyGems', 'go.sum': 'Go', 'go.mod': 'Go',
    'Cargo.lock': 'crates.io', 'composer.lock': 'Packagist', 'pubspec.lock': 'Pub',
    'mix.lock': 'Hex', 'pom.xml': 'Maven', 'gradle.lockfile': 'Maven',
};

const ecosystemOf = (filename) => ECOSYSTEM[filename.split('/').pop()] ?? null;

/**
 * The oracle: does OSV list this exact package version as affected?
 *
 * Returns every identifier, ALIASES INCLUDED. OSV keys advisories by GHSA id
 * and carries the CVE as an alias, so comparing a model's `CVE-…` citation
 * against ids alone marks a correct answer as a hallucination — which it did,
 * on the first claim this eval ever scored.
 */
async function osv(name, version, ecosystem) {
    const body = JSON.stringify({ package: { name, ecosystem }, version });
    const res = await fetch('https://api.osv.dev/v1/query', { method: 'POST', body });
    if (!res.ok) return null;
    const json = await res.json();
    return (json.vulns ?? []).flatMap((v) => [v.id, ...(v.aliases ?? [])]);
}

async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
}

async function main() {
    applyModelEnv(MODEL);
    const { generateText } = require('ai');
    const model = buildEvalModel({}, MODEL);

    const rows = require('../../scripts/analyzer-prevalence/result.json').rows
        .filter((r) => !r.skipped && !r.fork && !r.archived && r.fired.includes('dependencies'))
        .slice(0, LIMIT);

    process.stderr.write(`reviewing ${rows.length} lockfile PRs with ${MODEL}\n`);

    const results = await pool(rows, CONCURRENCY, async (pr, idx) => {
        let files;
        try {
            const { stdout } = await exec('gh', ['api',
                `repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`,
                '--jq', '[.[] | select(.patch != null) | {path: .filename, patch: .patch}]',
            ], { maxBuffer: 64 * 1024 * 1024 });
            files = JSON.parse(stdout);
        } catch { return null; }

        const locks = files.filter((f) => ecosystemOf(f.path));
        if (!locks.length) return null;

        const diff = locks
            .map((f) => `--- a/${f.path}\n+++ b/${f.path}\n${f.patch.slice(0, 12000)}`)
            .join('\n\n');

        let text = '';
        try {
            const res = await generateText({
                model,
                system: buildCategoryReviewPrompt('security'),
                prompt:
                    'This pull request changes dependency lockfiles. Report any package ' +
                    'version it introduces that has a KNOWN security vulnerability.\n' +
                    'JSON only:\n' +
                    '{"findings":[{"package":"<name>","version":"<exact version>",' +
                    '"advisory":"<GHSA or CVE id>","severity":"critical|high|medium|low"}]}\n' +
                    'If none, respond {"findings":[]}. Do not guess: only report what you ' +
                    'believe is a real published advisory.\n\n```diff\n' + diff + '\n```',
                maxRetries: 2,
            });
            text = res.text || '';
        } catch (e) { return { pr, error: String(e.message || e).slice(0, 90) }; }

        const m = text.match(/\{[\s\S]*\}/);
        let claims = [];
        if (m) { try { claims = JSON.parse(m[0]).findings || []; } catch { /* unparsed */ } }

        const eco = ecosystemOf(locks[0].path);
        const checked = [];
        for (const c of claims) {
            if (!c.package || !c.version) continue;
            let ids = null;
            try { ids = await osv(String(c.package), String(c.version), eco); } catch { ids = null; }
            checked.push({
                package: c.package, version: c.version, advisory: c.advisory ?? null,
                osvIds: ids,
                packageVulnerable: Array.isArray(ids) && ids.length > 0,
                advisoryConfirmed: Array.isArray(ids) && c.advisory
                    ? ids.includes(String(c.advisory))
                    : false,
            });
        }

        process.stderr.write(`${idx + 1} `);
        return { pr: `${pr.repo}#${pr.number}`, bot: pr.bot, ecosystem: eco, claims: checked };
    });

    const ok = results.filter((r) => r && r.claims);
    const all = ok.flatMap((r) => r.claims);
    const vulnerable = all.filter((c) => c.packageVulnerable);
    const refuted = all.filter((c) => c.osvIds !== null && !c.packageVulnerable);
    const confirmed = all.filter((c) => c.advisoryConfirmed);
    const wrongId = vulnerable.filter((c) => c.advisory && !c.advisoryConfirmed);
    const unknown = all.filter((c) => c.osvIds === null);

    const pct = (x) => (all.length ? `${((x / all.length) * 100).toFixed(1)}%` : 'n/a');
    console.log(`\n\n=== refutation: dependency claims vs OSV (${MODEL}) ===`);
    console.log(`PRs reviewed: ${ok.length}   PRs with at least one claim: ${ok.filter((r) => r.claims.length).length}`);
    console.log(`total claims: ${all.length}\n`);
    console.log(`  package genuinely vulnerable   : ${vulnerable.length}  (${pct(vulnerable.length)})`);
    console.log(`    of which the advisory matched: ${confirmed.length}`);
    console.log(`    right package, wrong id      : ${wrongId.length}`);
    console.log(`  OSV REFUTES the claim entirely : ${refuted.length}  (${pct(refuted.length)})   <- suppressible`);
    console.log(`  OSV could not answer           : ${unknown.length}`);

    if (refuted.length) {
        console.log('\nrefuted claims (model said vulnerable, OSV says clean):');
        for (const c of refuted.slice(0, 15)) {
            console.log(`  ${c.package}@${c.version}  claimed ${c.advisory ?? '(no id)'}`);
        }
    }

    const out = args.json || path.join(__dirname, 'refutation-run.json');
    fs.writeFileSync(out, JSON.stringify(results.filter(Boolean), null, 2));
    console.log(`\nper-PR: ${out}`);
}

main().catch((e) => { console.error(e); process.exit(2); });
