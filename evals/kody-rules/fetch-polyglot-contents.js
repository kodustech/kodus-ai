// Augment polyglot-cases.json with the real file CONTENT at the PR head.
//
// The corpus carries diffs only, which is all the fan-out measurement needed.
// Measuring what issue #1826 step 1 costs needs the other half: the shard now
// carries the whole file, so the added prompt weight IS the file content.
//
//   node evals/kody-rules/fetch-polyglot-contents.js [--prs=12]
//
// Writes polyglot-cases-with-content.json (gitignored). gh CLI must be authed.
// Read-only against public repos.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const PRS = +(args.prs || 12);

const cases = require('./polyglot-cases.json').slice(0, PRS);

// The head SHA of the PR — the same commit the diff describes. Anything else
// and the content would not line up with the hunks, which is the exact
// inconsistency this measurement must not introduce into its own numbers.
function headSha(repo, prNumber) {
    try {
        return JSON.parse(execSync(`gh api "repos/${repo}/pulls/${prNumber}" 2>/dev/null`, { maxBuffer: 32 * 1024 * 1024 }).toString()).head.sha;
    } catch { return null; }
}
function contentAt(repo, sha, filePath) {
    try {
        const out = execSync(`gh api "repos/${repo}/contents/${encodeURI(filePath)}?ref=${sha}" -H "Accept: application/vnd.github.raw" 2>/dev/null`, { maxBuffer: 32 * 1024 * 1024 });
        return out.toString();
    } catch { return null; }
}

let files = 0, got = 0;
for (const c of cases) {
    const prNumber = String(c.caseId).split('#')[1];
    const sha = headSha(c.repo, prNumber);
    if (!sha) { console.warn(`! ${c.caseId}: no head sha`); continue; }
    for (const f of c.realChangedFiles) {
        files++;
        const text = contentAt(c.repo, sha, f.filename);
        if (text != null) { f.content = text; got++; }
    }
    console.log(`  ${c.caseId}: ${c.realChangedFiles.filter((f) => f.content).length}/${c.realChangedFiles.length} files`);
}

const out = path.join(__dirname, 'polyglot-cases-with-content.json');
fs.writeFileSync(out, JSON.stringify(cases, null, 2));
console.log(`\nwrote ${cases.length} PRs, ${got}/${files} files with content -> ${path.relative(process.cwd(), out)}`);
