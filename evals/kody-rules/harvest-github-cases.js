// Harvest REAL kody-rules cases from live GitHub PRs.
//
// The benchmark datasets are from clean repos, so the same convention is rarely
// violated more than once per PR. To test enumeration faithfully we need real
// PRs that genuinely break a rule in several places. This pulls recent MERGED
// PRs from a set of large TS repos, converts each file's unified diff into the
// engine's patchWithLinesStr format, enumerates the real occurrences of each
// pattern in ADDED lines (the ground truth), and — for PRs that break a rule
// >=2 times — fetches the real file contents at the PR head as readFile replay.
//
//   node evals/kody-rules/harvest-github-cases.js [--repos a/b,c/d] [--per 25] [--want 12]
//
// Writes github-cases.json (gitignored). gh CLI must be authed.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const REPOS = (args.repos ? String(args.repos).split(',') : [
    'n8n-io/n8n', 'directus/directus', 'medusajs/medusa', 'novuhq/novu',
    'twentyhq/twenty', 'appsmithorg/appsmith', 'nestjs/nest', 'typeorm/typeorm',
    'backstage/backstage', 'grafana/grafana',
]);
const PER = +(args.per || 25);     // merged PRs to scan per repo
const WANT = +(args.want || 14);   // stop after this many good cases

const PATTERNS = {
    'no-direct-process-env': { rx: /\bprocess\.env\./, title: 'No direct process.env access', rule: 'Application code must not read process.env directly. Resolve configuration through the typed config/env module so values are validated and mockable.', path: '**/*.{ts,tsx}' },
    'no-console': { rx: /\bconsole\.(log|warn|error|debug)\s*\(/, title: 'No console.* in app code', rule: 'Never use console.log/console.error/console.warn/console.debug in application code; use the structured logger.', path: '**/*.{ts,tsx}' },
    'no-generic-error': { rx: /\bthrow new Error\(/, title: 'No generic Error — throw a typed error', rule: 'Do not `throw new Error(...)` with the generic Error class. Throw a domain-specific error type so callers can discriminate.', path: '**/*.{ts,tsx}' },
    'no-any-type': { rx: /(:\s*any\b|\bas any\b)/, title: 'No `any` type', rule: 'Do not use the TypeScript `any` type (annotation or `as any` cast). Use a concrete type or `unknown` with narrowing.', path: '**/*.{ts,tsx}' },
};

function gh(endpoint) {
    return JSON.parse(execSync(`gh api "${endpoint}" 2>/dev/null`, { maxBuffer: 64 * 1024 * 1024 }).toString() || 'null');
}
// Search merged PRs for a repo → array of {number}. Uses the search API so we
// only ever look at actually-merged PRs (not closed-without-merge).
function searchMergedPRs(repo, n) {
    try {
        const out = execSync(`gh api -X GET search/issues -f q='repo:${repo} is:pr is:merged' -F per_page=${Math.min(n, 100)} 2>/dev/null`, { maxBuffer: 64 * 1024 * 1024 }).toString();
        const j = JSON.parse(out || 'null');
        return Array.isArray(j?.items) ? j.items : [];
    } catch { return []; }
}
function ghRaw(endpoint) {
    try { return execSync(`gh api ${endpoint} 2>/dev/null`, { maxBuffer: 64 * 1024 * 1024 }).toString(); } catch { return null; }
}

// Convert a GitHub unified-diff patch into the engine's patchWithLinesStr.
// Added lines carry their NEW file line number so ground-truth enumeration and
// the model agree on line numbers.
function toPatchWithLines(filename, patch) {
    if (!patch) return null;
    const out = [`## file: '${filename}'`, ''];
    for (const raw of patch.split('\n')) {
        const hm = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
        if (hm) { out.push(raw, '__new hunk__'); var newLine = +hm[1]; continue; }
        if (newLine === undefined) continue;
        if (raw.startsWith('+')) { out.push(`${newLine} +${raw.slice(1)}`); newLine++; }
        else if (raw.startsWith('-')) { /* removed: omit from new hunk */ }
        else { out.push(`${newLine}  ${raw.slice(1)}`); newLine++; }
    }
    return out.join('\n');
}

function enumerate(changedFiles, rx) {
    const gt = {};
    for (const f of changedFiles) {
        const sites = [];
        for (const ln of String(f.patchWithLinesStr || '').split('\n')) {
            const m = ln.match(/^\s*(\d+)\s*\+(.*)$/);
            if (m && rx.test(m[2])) sites.push({ line: +m[1], code: m[2].trim().slice(0, 80) });
        }
        if (sites.length) gt[f.filename] = sites;
    }
    return gt;
}

const cases = [];
outer:
for (const repo of REPOS) {
    const found = searchMergedPRs(repo, PER);
    if (!found.length) { console.warn(`! ${repo}: search returned 0`); continue; }
    console.log(`\n${repo}: scanning ${found.length} merged PRs…`);
    for (const item of found) {
        let files;
        try { files = gh(`repos/${repo}/pulls/${item.number}/files?per_page=100`); } catch { continue; }
        if (!Array.isArray(files)) continue;
        // skip deploy/release/promotion PRs — they bulk-move code without being
        // a real change, so their "violations" are not meaningful test signal.
        if (/(\bpromotion\b|chore\(root\):\s*release|^\d{1,2}\/\d{1,2}\/\d{2,4})/i.test(item.title || '')) continue;
        let pr;
        try { pr = gh(`repos/${repo}/pulls/${item.number}`); } catch { continue; }
        if (!pr?.head?.sha) continue;
        // only TS/TSX source, skip tests/specs/d.ts
        const src = files.filter((f) => /\.(ts|tsx)$/.test(f.filename) && !/\.(spec|test|d)\.ts/.test(f.filename) && f.patch);
        if (!src.length) continue;
        const changedFiles = src.map((f) => ({ filename: f.filename, patchWithLinesStr: toPatchWithLines(f.filename, f.patch) }));
        for (const [uuid, spec] of Object.entries(PATTERNS)) {
            const gt = enumerate(changedFiles, spec.rx);
            const occ = Object.values(gt).reduce((a, b) => a + b.length, 0);
            if (occ < 2) continue;
            // fetch real file contents at head for readFile replay
            const replay = { readFile: [] };
            for (const f of changedFiles) {
                const c = ghRaw(`repos/${repo}/contents/${encodeURIComponent(f.filename).replace(/%2F/g, '/')}?ref=${pr.head.sha}`);
                if (c) { try { const j = JSON.parse(c); if (j.content) replay.readFile.push({ match: { path: f.filename }, result: Buffer.from(j.content, 'base64').toString('utf8') }); } catch {} }
            }
            cases.push({
                caseId: `${repo}#${pr.number}::${uuid}`,
                source: `https://github.com/${repo}/pull/${pr.number}`,
                rule: { uuid, ...spec, rx: undefined },
                title: pr.title, body: '',
                maxSteps: 28,
                realChangedFiles: changedFiles,
                toolReplay: replay,
                violatingFiles: Object.keys(gt),
                cleanFiles: changedFiles.map((f) => f.filename).filter((fn) => !gt[fn]),
                groundTruth: gt,
            });
            console.log(`  ✓ #${pr.number} ${uuid.padEnd(22)} ${occ} occ / ${Object.keys(gt).length}f  — ${pr.title.slice(0, 44)}`);
            if (cases.length >= WANT) break outer;
        }
    }
}

// strip the regex object from rule before writing
for (const c of cases) delete c.rule.rx;
fs.writeFileSync(path.join(__dirname, 'github-cases.json'), JSON.stringify(cases, null, 2));
console.log(`\nWrote ${cases.length} GitHub cases → evals/kody-rules/github-cases.json`);
