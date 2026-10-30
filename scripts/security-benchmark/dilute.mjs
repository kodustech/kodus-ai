/**
 * Plant each vulnerability inside a realistically sized pull request.
 *
 * A sample built by inverting a fix commit is one to eight files, all of them
 * about the vulnerability. A reviewer reading that is not doing the job it does
 * in production, where the same hunk arrives inside thirty files of unrelated
 * work. If the reviewer's advantage over a pattern matcher comes from the
 * sample being small and focused, diluting it is what exposes that.
 *
 * Filler is real: changed files from the sampled public PRs, never synthesised.
 * The vulnerable files keep their patches untouched and are shuffled into the
 * middle, so position carries no signal.
 *
 * Usage: node scripts/security-benchmark/dilute.mjs <dataset.json> <prs.json> <out.json> [--files 25]
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const [DATASET, PRS, OUT] = process.argv.slice(2);
const TARGET = Number(
    process.argv.includes('--files')
        ? process.argv[process.argv.indexOf('--files') + 1]
        : 25,
);
const MAX_PATCH = 4000; // keep a prompt from being dominated by one huge file

const data = JSON.parse(readFileSync(DATASET, 'utf8'));
const all = Array.isArray(data) ? data : Object.values(data).find(Array.isArray);
const prs = JSON.parse(readFileSync(PRS, 'utf8')).prs;

// Collect filler from real PRs until there is plenty to draw from.
const filler = [];
let cursor = 0;
while (filler.length < 900 && cursor < prs.length) {
    const pr = prs[cursor++];
    try {
        const { stdout } = await exec('gh', [
            'api', `repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`,
            '--jq', '[.[] | select(.patch != null) | {path: .filename, patch: .patch}]',
        ], { maxBuffer: 64 * 1024 * 1024 });
        for (const f of JSON.parse(stdout)) {
            if (f.patch.length > MAX_PATCH) continue;
            filler.push(f);
        }
    } catch { /* gone or private */ }
    if (cursor % 10 === 0) process.stderr.write(`${filler.length} `);
}
process.stderr.write(`\ncollected ${filler.length} filler files\n`);

let seed = 42;
const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
};

const diluted = all.map((sample) => {
    if (sample.tranche !== 'vuln') return sample;

    const own = sample.files ?? [];
    const ownPaths = new Set(own.map((f) => f.path));
    const need = Math.max(0, TARGET - own.length);

    const picked = [];
    let guard = 0;
    while (picked.length < need && guard++ < need * 20 && filler.length) {
        const f = filler[Math.floor(rand() * filler.length)];
        // Never shadow a path the sample already uses.
        if (ownPaths.has(f.path) || picked.some((p) => p.path === f.path)) continue;
        picked.push({ path: f.path, patch: f.patch });
    }

    const merged = [...own, ...picked];
    for (let i = merged.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [merged[i], merged[j]] = [merged[j], merged[i]];
    }

    return { ...sample, files: merged, dilutedTo: merged.length };
});

writeFileSync(OUT, JSON.stringify(diluted, null, 2));
const v = diluted.filter((s) => s.tranche === 'vuln');
const avg = v.reduce((a, s) => a + (s.dilutedTo ?? 0), 0) / v.length;
process.stderr.write(`wrote ${OUT}: ${v.length} vuln samples, mean ${avg.toFixed(1)} files each\n`);
