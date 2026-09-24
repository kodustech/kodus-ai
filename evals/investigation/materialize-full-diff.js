#!/usr/bin/env node
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Writes each case's COMPLETE diff into its dataset, from the local clone.
 *
 * The datasets were extracted with the defaults of extract-benchmark-case.js —
 * `maxFiles: 6` and `includeTests: false` — and nothing recorded what was cut:
 * `omittedFilePaths` is empty even on a PR where 141 of 142 files were dropped.
 * Across the light set that leaves 106 files in the datasets against 809 in the
 * real PRs, 221 of them tests. Every measurement so far describes a review of
 * roughly an eighth of the change.
 *
 * Tools were never the limit — with RECALL_REAL_REPO=1 grep and readFile reach
 * the whole worktree. What the agent lacked was knowing those files changed, and
 * what changed in them, which is exactly what a diff carries.
 *
 * Written to `changedFilesFull`, NOT over `changedFiles`: keeping both makes the
 * six-file view and the complete view an A/B on the same corpus instead of a
 * migration that invalidates every earlier number.
 *
 * Usage:
 *   node evals/investigation/materialize-full-diff.js [--set=light] [--case=<id>]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// The exact pair fetch-changed-files.stage.ts runs on every production review:
// deletions handled first, then the unified rendering with new-file line
// numbers. The dataset extractor used convertToHunksWithLinesNumbers instead —
// the __new hunk__ / __old hunk__ split — so the corpus has been feeding the
// model a different shape of the same diff than the product does. In the
// production form a removed line sits next to the line that replaced it, in
// file order; in the extractor's form the new block and the old block are
// separated, and "what changed on this line" has to be reassembled.
const {
    handlePatchDeletions,
    convertToUnifiedDiffWithLineNumbers,
} = require('@libs/common/utils/patch');
const { repoDirFor } = require('./prepare-repo');

const DATASETS = path.join(__dirname, 'datasets');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const SET = arg('set', 'light');
const ONLY = arg('case');

function caseIds(name) {
    const src = fs.readFileSync(path.join(__dirname, 'recall-tests.js'), 'utf8');
    const block = src.match(
        new RegExp(`${name.toUpperCase()}_CASES\\s*=\\s*\\[([\\s\\S]*?)\\]`),
    );
    if (!block) throw new Error(`no ${name.toUpperCase()}_CASES`);
    return new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

const git = (dir, args) =>
    execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
    });

/** The base a diff is taken from. Six light cases (all discourse) carry no
 *  `benchmarkBaseRef` because they were extracted from bare commits rather than
 *  PRs — the first parent IS their base. */
function basesFor(vars, repo) {
    const head = vars.benchmarkHeadRef;
    if (!head) return null;
    let base = vars.benchmarkBaseRef;
    if (!base) {
        try {
            base = git(repo, ['rev-parse', `${head}^`]).trim();
        } catch {
            return null;
        }
    }
    return { base, head };
}

const wanted = ONLY ? new Set([ONLY]) : caseIds(SET);
let done = 0,
    skipped = 0,
    before = 0,
    after = 0,
    bytes = 0;

for (const file of fs.readdirSync(DATASETS)) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(DATASETS, file);
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
        continue;
    }
    const entry = Array.isArray(raw) ? raw[0] : raw;
    const vars = entry?.vars;
    if (!vars || !wanted.has(vars.caseId)) continue;

    const repo = repoDirFor(vars.repositoryFullName);
    if (!repo || !fs.existsSync(repo)) {
        console.log(`${vars.caseId}: SKIP (sem clone)`);
        skipped++;
        continue;
    }
    const refs = basesFor(vars, repo);
    if (!refs) {
        console.log(`${vars.caseId}: SKIP (sem base/head)`);
        skipped++;
        continue;
    }

    let names;
    try {
        names = git(repo, [
            'diff',
            '--name-status',
            '--no-renames',
            // TRES pontos: so o que o PR mudou desde que divergiu da base. Com
            // dois pontos entra tudo que foi mergeado na base depois que o PR
            // abriu, e a revisao passa a ver arquivos que o revisor nunca viu.
            `${refs.base}...${refs.head}`,
        ])
            .split('\n')
            .filter(Boolean)
            .map((l) => {
                const [status, ...rest] = l.split('\t');
                return { status: status.trim(), filename: rest.join('\t').trim() };
            })
            .filter((f) => f.filename);
    } catch (err) {
        console.log(`${vars.caseId}: FAIL diff (${String(err).slice(0, 80)})`);
        skipped++;
        continue;
    }

    const out = [];
    for (const f of names) {
        // A deleted file has no post-image to anchor line numbers to, and a
        // binary one has no text diff at all; both would render as an empty
        // hunk block that only costs prompt space.
        if (f.status === 'D') continue;
        let patch = '';
        try {
            patch = git(repo, ['diff', `${refs.base}...${refs.head}`, '--', f.filename]);
        } catch {
            continue;
        }
        if (!patch.trim() || /^Binary files /m.test(patch)) continue;

        // A git patch carries a header (`diff --git`, `index`, `---`, `+++`)
        // that a provider's API patch field does not. Left in, the renderer
        // numbers those four lines as if they were code, producing rows at
        // line -1 and 0.
        const at = patch.indexOf('\n@@');
        if (at === -1) continue;
        const body = patch.slice(at + 1);

        let rendered = '';
        try {
            const cleaned = handlePatchDeletions(body, f.filename, f.status);
            if (!cleaned) continue;
            rendered = convertToUnifiedDiffWithLineNumbers(cleaned, {
                filename: f.filename,
            });
        } catch {
            continue;
        }
        if (!rendered.trim()) continue;
        // computeFileScores reads these directly; derived here because the
        // rendered form no longer carries bare +/- prefixes to count.
        const additions = (body.match(/^\+(?!\+\+)/gm) || []).length;
        const deletions = (body.match(/^-(?!--)/gm) || []).length;
        out.push({
            filename: f.filename,
            patchWithLinesStr: rendered,
            status: f.status === 'A' ? 'added' : 'modified',
            additions,
            deletions,
        });
    }

    const prev = (() => {
        try {
            return (
                typeof vars.changedFiles === 'string'
                    ? JSON.parse(vars.changedFiles)
                    : vars.changedFiles || []
            ).length;
        } catch {
            return 0;
        }
    })();

    vars.changedFilesFull = JSON.stringify(out);
    vars.fullDiffMeta = JSON.stringify({
        base: refs.base,
        head: refs.head,
        files: out.length,
        generatedAt: new Date().toISOString().slice(0, 10),
    });
    fs.writeFileSync(full, JSON.stringify(raw, null, 2));

    const size = vars.changedFilesFull.length;
    bytes += size;
    before += prev;
    after += out.length;
    done++;
    console.log(
        `${vars.caseId.slice(0, 52).padEnd(54)} ${String(prev).padStart(3)} → ${String(out.length).padStart(4)} arquivos  ${(size / 1024).toFixed(0)}KB`,
    );
}

console.log(
    `\n${done} casos gravados, ${skipped} pulados | ${before} → ${after} arquivos | ${(bytes / 1024 / 1024).toFixed(1)}MB de diff`,
);
