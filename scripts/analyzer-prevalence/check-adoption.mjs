/**
 * How many repositories actually CONFIGURE the config-driven analyzers?
 *
 * `selectFiles` answers "does this PR contain files the tool understands",
 * which for ruff and ast-grep is an upper bound rather than an answer: both run
 * the repository's OWN rules and do nothing without them. A repository that has
 * never adopted ruff gets no ruff findings no matter how many .py files a PR
 * touches, so prevalence for these two is the CONFIGURED rate, not the
 * file-type rate.
 *
 * Usage: node scripts/analyzer-prevalence/check-adoption.mjs result.json
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const rows = JSON.parse(readFileSync(process.argv[2], 'utf8')).rows
    .filter((r) => !r.skipped && !r.fork && !r.archived);

async function hasPath(repo, path) {
    try {
        await exec('gh', ['api', `repos/${repo}/contents/${path}`, '--silent']);
        return true;
    } catch { return false; }
}

/** ruff reads ruff.toml, .ruff.toml, or a [tool.ruff] table in pyproject.toml. */
async function ruffConfigured(repo) {
    if (await hasPath(repo, 'ruff.toml')) return true;
    if (await hasPath(repo, '.ruff.toml')) return true;
    try {
        const { stdout } = await exec('gh', [
            'api', `repos/${repo}/contents/pyproject.toml`, '--jq', '.content',
        ], { maxBuffer: 32 * 1024 * 1024 });
        return Buffer.from(stdout.trim(), 'base64').toString('utf8').includes('[tool.ruff');
    } catch { return false; }
}

async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
}

const uniq = (xs) => [...new Set(xs)];
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');

// ruff: only repositories whose PRs actually carried Python.
const ruffRepos = uniq(rows.filter((r) => r.fired.includes('ruff')).map((r) => r.repo));
process.stderr.write(`checking ruff config in ${ruffRepos.length} repos\n`);
const ruffHits = (await pool(ruffRepos, 6, ruffConfigured)).filter(Boolean).length;

// ast-grep applies to any language, so sample the whole usable set.
const allRepos = uniq(rows.map((r) => r.repo));
const sample = allRepos.slice(0, 250);
process.stderr.write(`checking ast-grep config in ${sample.length} repos\n`);
const sgHits = (await pool(sample, 6, (r) => hasPath(r, 'sgconfig.yml'))).filter(Boolean).length;

console.log(`\nruff configured    : ${ruffHits}/${ruffRepos.length} repos with Python in the diff  (${pct(ruffHits, ruffRepos.length)})`);
console.log(`ast-grep configured: ${sgHits}/${sample.length} sampled repos  (${pct(sgHits, sample.length)})`);
console.log(`\nSo PR-level prevalence, corrected for adoption:`);
const ruffPrs = rows.filter((r) => r.fired.includes('ruff')).length;
console.log(`  ruff     : ${pct(ruffPrs, rows.length)} of PRs carry Python, of which ${pct(ruffHits, ruffRepos.length)} of repos configure ruff`);
console.log(`             -> roughly ${((ruffPrs / rows.length) * (ruffHits / Math.max(ruffRepos.length, 1)) * 100).toFixed(1)}% of PRs`);
console.log(`  ast-grep : ~${pct(sgHits, sample.length)} of PRs (config is repo-wide)`);
