/**
 * Build a corpus of REAL pull requests that genuinely introduced a
 * vulnerability.
 *
 * Every earlier corpus was constructed. Inverting a fix commit yields real
 * code but a diff no human ever opened, and padding it with files from
 * unrelated repositories yields a shape no repository ever produced. Both
 * objections vanish if the sample IS the pull request that introduced the flaw:
 * real code, real size, real authorial intent, and an advisory published later
 * as ground truth that the flaw was genuine.
 *
 * Construction, per advisory:
 *   1. blame the vulnerable lines at the commit BEFORE the fix;
 *   2. the commit that wrote them belongs to a pull request — that is the one;
 *   3. take that pull request's real diff;
 *   4. locate the vulnerable lines inside it BY CONTENT, because line numbers
 *      differ between the introducing PR and the pre-fix state;
 *   5. pad to a large diff with other merged PRs FROM THE SAME REPOSITORY, so
 *      the filler is plausibly part of the same codebase.
 *
 * A sample is dropped unless its vulnerable text is actually found among the
 * lines the pull request added — that check is what makes the label true.
 *
 * Usage:
 *   node scripts/security-benchmark/build-real-pr-corpus.mjs out.json \
 *       [--in advisories.json] [--min-files 40] [--limit 60]
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const OUT = process.argv[2];
const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? d : process.argv[i + 1];
};
const MIN_FILES = Number(arg('min-files', 40));
const LIMIT = Number(arg('limit', 60));

const gh = async (args, buf = 64 * 1024 * 1024) => {
    const { stdout } = await exec('gh', args, { maxBuffer: buf });
    return stdout;
};

const BLAME = `
query($owner:String!,$name:String!,$expr:String!,$path:String!){
  repository(owner:$owner,name:$name){
    object(expression:$expr){
      ... on Commit {
        blame(path:$path){
          ranges{ startingLine endingLine
            commit{ oid associatedPullRequests(first:1){nodes{number}} } } } } } }
}`;

/** New-side line numbers a patch adds, with their text. */
function addedWithText(patch) {
    const out = [];
    let cursor = 0;
    for (const raw of String(patch || '').split('\n')) {
        const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (h) { cursor = parseInt(h[1], 10); continue; }
        if (raw.startsWith('+')) { out.push({ line: cursor, text: raw.slice(1) }); cursor++; }
        else if (!raw.startsWith('-')) cursor++;
    }
    return out;
}

async function introducingPr(repo, sha, path, wantLines) {
    const [owner, name] = repo.split('/');
    let json;
    try {
        json = JSON.parse(await gh(['api', 'graphql',
            '-f', `query=${BLAME}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
            '-f', `expr=${sha}`, '-f', `path=${path}`]));
    } catch { return null; }

    const ranges = json?.data?.repository?.object?.blame?.ranges;
    if (!Array.isArray(ranges)) return null;

    const want = new Set(wantLines);
    const tally = new Map();
    for (const r of ranges) {
        const covered = [];
        for (let l = r.startingLine; l <= r.endingLine; l++) if (want.has(l)) covered.push(l);
        if (!covered.length) continue;
        const pr = r.commit?.associatedPullRequests?.nodes?.[0]?.number;
        if (!pr) continue;
        const cur = tally.get(pr) ?? [];
        tally.set(pr, [...cur, ...covered]);
    }
    if (!tally.size) return null;
    const [number, lines] = [...tally.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    return { number, lines };
}

/** Text of specific 1-based lines of a file at a commit. */
async function linesAt(repo, sha, path, lines) {
    try {
        const b64 = await gh(['api', `repos/${repo}/contents/${encodeURI(path)}?ref=${sha}`, '--jq', '.content']);
        const content = Buffer.from(b64.trim(), 'base64').toString('utf8').split('\n');
        return lines.map((l) => content[l - 1]).filter((t) => typeof t === 'string');
    } catch { return []; }
}

async function prFiles(repo, number) {
    try {
        return JSON.parse(await gh(['api',
            `repos/${repo}/pulls/${number}/files?per_page=100`,
            '--jq', '[.[] | select(.patch != null) | {path: .filename, patch: .patch}]']));
    } catch { return []; }
}

/** Other merged PRs from the same repo, for coherent padding. */
const fillerCache = new Map();
async function repoFiller(repo, exclude) {
    if (!fillerCache.has(repo)) {
        let nums = [];
        try {
            nums = JSON.parse(await gh(['api',
                `repos/${repo}/pulls?state=closed&per_page=30`,
                '--jq', '[.[] | select(.merged_at != null) | .number]']));
        } catch { /* none */ }
        const files = [];
        for (const n of nums.slice(0, 6)) {
            for (const f of await prFiles(repo, n)) {
                if (f.patch.length <= 4000) files.push({ ...f, fromPr: n });
            }
            if (files.length > 150) break;
        }
        fillerCache.set(repo, files);
    }
    return fillerCache.get(repo).filter((f) => f.fromPr !== exclude);
}

const IN = arg('in', 'scripts/security-benchmark/dataset.json');
const data = JSON.parse(readFileSync(IN, 'utf8'));
const all = Array.isArray(data) ? data : Object.values(data).find(Array.isArray);
const samples = all.filter((s) => s.tranche === 'vuln' && s.source?.advisory).slice(0, LIMIT);

const built = [];
const dropped = { noBlame: 0, noPr: 0, noTextMatch: 0, noFiles: 0 };

for (const [i, s] of samples.entries()) {
    const entries = s.expected ?? [];
    if (!entries.length) { dropped.noBlame++; continue; }

    // Every file the fix touched is a chance to find the introducing PR: the
    // first one may have been written by a direct push with no PR attached.
    let entry = null;
    let found = null;
    for (const cand of entries) {
        const hit = await introducingPr(s.source.repo, s.source.vulnerableCommit, cand.path, cand.lines);
        if (hit && (!found || hit.lines.length > found.lines.length)) {
            found = hit;
            entry = cand;
        }
    }
    if (!found) { dropped.noPr++; process.stderr.write('.'); continue; }

    const text = await linesAt(s.source.repo, s.source.vulnerableCommit, entry.path, found.lines);
    const files = await prFiles(s.source.repo, found.number);
    if (!files.length) { dropped.noFiles++; process.stderr.write('x'); continue; }

    // Locate the vulnerable code inside the real PR, by content.
    const target = files.find((f) => f.path === entry.path);
    const wanted = new Set(text.map((t) => t.trim()).filter((t) => t.length > 3));
    const expectedLines = target
        ? addedWithText(target.patch).filter((a) => wanted.has(a.text.trim())).map((a) => a.line)
        : [];

    if (!expectedLines.length) { dropped.noTextMatch++; process.stderr.write('-'); continue; }

    // Bury it: pad with real files from the same repository.
    const merged = [...files];
    if (merged.length < MIN_FILES) {
        const pad = await repoFiller(s.source.repo, found.number);
        const seen = new Set(merged.map((f) => f.path));
        for (const f of pad) {
            if (merged.length >= MIN_FILES) break;
            if (seen.has(f.path)) continue;
            seen.add(f.path);
            merged.push({ path: f.path, patch: f.patch });
        }
    }
    // Shuffle so position carries no signal.
    for (let k = merged.length - 1; k > 0; k--) {
        const j = (k * 7919 + i * 104729) % (k + 1);
        [merged[k], merged[j]] = [merged[j], merged[k]];
    }

    // The scorer reconstructs content from the patch when none is stored, which
    // shifts line numbers and can yield a file the analyzer cannot parse. Store
    // the real thing for the file that carries the vulnerability.
    let vulnContent = null;
    try {
        const headSha = (await gh(['api', `repos/${s.source.repo}/pulls/${found.number}`, '--jq', '.head.sha'])).trim();
        const b64 = await gh(['api', `repos/${s.source.repo}/contents/${encodeURI(entry.path)}?ref=${headSha}`, '--jq', '.content']);
        vulnContent = Buffer.from(b64.trim(), 'base64').toString('utf8');
    } catch { /* fall back to reconstruction */ }
    if (vulnContent) {
        const f = merged.find((x) => x.path === entry.path);
        if (f) f.content = vulnContent;
    }

    built.push({
        ...s,
        id: `${s.id}-realpr`,
        source: { ...s.source, introducedByPr: found.number, prUrl: `https://github.com/${s.source.repo}/pull/${found.number}` },
        expected: [{ path: entry.path, lines: expectedLines }],
        files: merged,
        realPrFiles: files.length,
        totalFiles: merged.length,
    });
    process.stderr.write('+');
}

// Carry the noise tranche across unchanged so precision stays measurable.
const noise = all.filter((s) => s.tranche === 'noise');
// Same shape the scorer expects: { samples: [...] }, not a bare array.
writeFileSync(OUT, JSON.stringify({ samples: [...built, ...noise] }, null, 2));

const avgReal = built.reduce((a, s) => a + s.realPrFiles, 0) / (built.length || 1);
const avgTot = built.reduce((a, s) => a + s.totalFiles, 0) / (built.length || 1);
process.stderr.write(`\n\nbuilt ${built.length} real-PR samples from ${samples.length} advisories\n`);
process.stderr.write(`  dropped: ${JSON.stringify(dropped)}\n`);
process.stderr.write(`  mean files in the real PR: ${avgReal.toFixed(1)} | after padding: ${avgTot.toFixed(1)}\n`);
