// Harvest a POLYGLOT corpus of real merged-PR diffs (issue #1831).
//
// The existing github-cases.json is TS/TSX only, so it cannot show the failure
// mode this issue is about: a language-scoped rule whose compiled T0 regex has
// no language scope and therefore fires on every OTHER language in the PR.
// We need real added lines in .rb/.erb/.js/.scss/.yml/.md/.vue — the exact mix
// reported in the incident (365 thumbs-down in 4 weeks, 349 on non-Ruby files).
//
//   node evals/kody-rules/harvest-polyglot-cases.js [--repos a/b,c/d] [--per 20] [--want 40]
//
// Writes polyglot-cases.json (gitignored — it is just public PR diffs, but it
// is bulky and re-harvestable). gh CLI must be authed.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
// Rails-shaped polyglot repos: Ruby app code side by side with JS, SCSS, YAML,
// Markdown and (chatwoot/gitlab) Vue — i.e. the shape of the customer repo in
// the incident, where a Ruby-only rule got applied to everything.
const REPOS = (args.repos ? String(args.repos).split(',') : [
    'discourse/discourse', 'mastodon/mastodon', 'forem/forem',
    'chatwoot/chatwoot', 'rubygems/rubygems', 'gitlabhq/gitlabhq',
]);
const PER = +(args.per || 20);   // merged PRs to scan per repo
const WANT = +(args.want || 40); // stop after this many PRs with usable diffs

// Same converter the TS harvester uses: added lines carry their NEW file line
// number, matching the engine's patchWithLinesStr contract exactly.
function toPatchWithLines(filename, patch) {
    if (!patch) return null;
    const out = [`## file: '${filename}'`, ''];
    let newLine;
    for (const raw of patch.split('\n')) {
        const hm = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
        if (hm) { out.push(raw, '__new hunk__'); newLine = +hm[1]; continue; }
        if (newLine === undefined) continue;
        if (raw.startsWith('+')) { out.push(`${newLine} +${raw.slice(1)}`); newLine++; }
        else if (raw.startsWith('-')) { /* removed: omit from new hunk */ }
        else { out.push(`${newLine}  ${raw.slice(1)}`); newLine++; }
    }
    return out.join('\n');
}

function gh(endpoint) {
    try { return JSON.parse(execSync(`gh api "${endpoint}" 2>/dev/null`, { maxBuffer: 64 * 1024 * 1024 }).toString() || 'null'); }
    catch { return null; }
}
function searchMergedPRs(repo, n) {
    try {
        const out = execSync(`gh api -X GET search/issues -f q='repo:${repo} is:pr is:merged' -F per_page=${Math.min(n, 100)} 2>/dev/null`, { maxBuffer: 64 * 1024 * 1024 }).toString();
        const j = JSON.parse(out || 'null');
        return Array.isArray(j?.items) ? j.items : [];
    } catch { return []; }
}

const cases = [];
outer:
for (const repo of REPOS) {
    const found = searchMergedPRs(repo, PER);
    if (!found.length) { console.warn(`! ${repo}: search returned 0`); continue; }
    console.log(`\n${repo}: scanning ${found.length} merged PRs…`);
    for (const item of found) {
        const files = gh(`repos/${repo}/pulls/${item.number}/files?per_page=100`);
        if (!Array.isArray(files)) continue;
        // Keep EVERY extension: the whole point is the cross-language spread.
        // Only drop binaries (no patch) and lockfiles/vendored blobs, which are
        // not code review targets in any engine config.
        const src = files.filter((f) => f.patch
            && !/(^|\/)(vendor|node_modules|dist|build)\//.test(f.filename)
            && !/\.(lock|min\.js|min\.css|svg|png|jpg|gif|woff2?)$/.test(f.filename)
            && !/(yarn\.lock|package-lock\.json|Gemfile\.lock)$/.test(f.filename));
        if (src.length < 2) continue;
        const changedFiles = src.map((f) => ({ filename: f.filename, patchWithLinesStr: toPatchWithLines(f.filename, f.patch) }));
        const exts = new Set(changedFiles.map((f) => (f.filename.match(/\.[^./]+$/) || ['none'])[0]));
        // A single-language PR tells us nothing about cross-language leakage.
        if (exts.size < 2) continue;
        cases.push({
            caseId: `${repo}#${item.number}`,
            source: `https://github.com/${repo}/pull/${item.number}`,
            repo,
            title: item.title || '',
            realChangedFiles: changedFiles,
        });
        console.log(`  + #${item.number} (${changedFiles.length} files, ${[...exts].join(' ')})`);
        if (cases.length >= WANT) break outer;
    }
}

const outPath = path.join(__dirname, 'polyglot-cases.json');
fs.writeFileSync(outPath, JSON.stringify(cases, null, 2));
const allExts = {};
let files = 0, addedLines = 0;
for (const c of cases) for (const f of c.realChangedFiles) {
    files++;
    const e = (f.filename.match(/\.[^./]+$/) || ['none'])[0];
    allExts[e] = (allExts[e] || 0) + 1;
    addedLines += String(f.patchWithLinesStr).split('\n').filter((l) => /^\s*\d+\s*\+/.test(l)).length;
}
console.log(`\nwrote ${cases.length} cases / ${files} files / ${addedLines} added lines -> ${path.relative(process.cwd(), outPath)}`);
console.log(Object.entries(allExts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
