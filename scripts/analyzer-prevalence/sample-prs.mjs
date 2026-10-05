/**
 * Draw a uniform random sample of merged public pull requests.
 *
 * The sampling frame is GH Archive (https://data.gharchive.org), the public
 * GitHub event stream published as one gzipped JSON file per hour. Sampling it
 * directly avoids the bias in the search API, which caps every query at a
 * thousand RANKED results — popular repositories would be over-represented by
 * construction, and popularity correlates with exactly the CI and packaging
 * hygiene we are trying to measure.
 *
 * The archived payload is reduced: `pull_request` carries only ids and refs, so
 * a merged PR is identified by `action === 'merged'` rather than the API's
 * `closed` + `merged: true`. Everything else about it — author, repository,
 * files — is fetched later, for the sampled PRs only.
 *
 * Usage:
 *   node scripts/analyzer-prevalence/sample-prs.mjs out.json \
 *       [--hours 12] [--sample 1200] [--seed 1] [--from 2025-09-18] [--to 2026-09-01]
 */
import { writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? fallback : process.argv[i + 1];
};

const OUT = process.argv[2];
if (!OUT) {
    console.error('usage: sample-prs.mjs <out.json> [--hours N] [--sample N] [--seed N]');
    process.exit(1);
}

const HOURS = Number(arg('hours', 12));
const SAMPLE = Number(arg('sample', 1200));
const SEED = Number(arg('seed', 1));
const FROM = new Date(arg('from', '2025-09-18'));
const TO = new Date(arg('to', '2026-09-01'));

/** Seeded PRNG so a run is reproducible from the seed alone. */
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = mulberry32(SEED);

const pad = (n) => String(n).padStart(2, '0');

/** Distinct random hours across the window, so no single day dominates. */
function pickHours(n) {
    const span = TO.getTime() - FROM.getTime();
    const seen = new Set();
    const out = [];
    let guard = 0;
    while (out.length < n && guard++ < n * 50) {
        const d = new Date(FROM.getTime() + rand() * span);
        const h = Math.floor(rand() * 24);
        const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${h}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

async function harvest(hourKey) {
    const url = `https://data.gharchive.org/${hourKey}.json.gz`;
    const res = await fetch(url);
    if (!res.ok) {
        process.stderr.write(`  ${hourKey}: HTTP ${res.status}, skipping\n`);
        return [];
    }

    const merged = [];
    const lines = createInterface({
        input: Readable.fromWeb(res.body).pipe(createGunzip()),
        crlfDelay: Infinity,
    });

    for await (const line of lines) {
        if (!line.includes('PullRequestEvent')) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type !== 'PullRequestEvent') continue;
        // The reduced archive schema states the merge directly.
        if (e.payload?.action !== 'merged') continue;
        const number = e.payload.number ?? e.payload.pull_request?.number;
        if (!e.repo?.name || !number) continue;
        merged.push({ repo: e.repo.name, number, at: e.created_at, hour: hourKey });
    }
    return merged;
}

const hours = pickHours(HOURS);
process.stderr.write(`sampling ${hours.length} archive hour(s)\n`);

const all = [];
for (const h of hours) {
    const got = await harvest(h);
    all.push(...got);
    process.stderr.write(`  ${h}: ${got.length} merged (running total ${all.length})\n`);
}

// One PR per (repo, number); an hour boundary can repeat an event.
const unique = [...new Map(all.map((p) => [`${p.repo}#${p.number}`, p])).values()];

// Uniform draw without replacement.
for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
}
const sample = unique.slice(0, SAMPLE);

writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    frame: 'gharchive',
    window: { from: FROM.toISOString(), to: TO.toISOString() },
    seed: SEED, hoursSampled: hours, harvested: unique.length, sampled: sample.length,
    prs: sample,
}, null, 2));

process.stderr.write(`\nharvested ${unique.length} unique merged PRs, wrote ${sample.length} to ${OUT}\n`);
