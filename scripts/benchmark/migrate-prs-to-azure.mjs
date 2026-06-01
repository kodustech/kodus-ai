#!/usr/bin/env node
/**
 * migrate-prs-to-azure.mjs
 *
 * Reads scripts/pr-creator/prs.json (GitHub form) and writes
 * scripts/pr-creator/prs-azure.json (Azure DevOps form).
 *
 * Only the `repo` field changes. Branches (head, base), titles,
 * source_url metadata and golden_comments are preserved verbatim —
 * the golden judging is text-only, so the Azure run reuses the same
 * ground truth.
 *
 * Usage:
 *   node scripts/benchmark/migrate-prs-to-azure.mjs \
 *     --azure-org=<org> --azure-project=<project>
 *
 * Optional:
 *   --in=<path>   default: scripts/pr-creator/prs.json
 *   --out=<path>  default: scripts/pr-creator/prs-azure.json
 *
 * Does NOT touch the GitHub prs.json. Pure read-then-write to a new file.
 */

import { readFileSync, writeFileSync } from 'node:fs';

// ---------- args ----------

const args = Object.fromEntries(
    process.argv
        .slice(2)
        .filter((a) => a.startsWith('--'))
        .map((a) => {
            const [k, v] = a.replace(/^--/, '').split('=');
            return [k, v ?? true];
        }),
);

const AZURE_ORG = args['azure-org'];
const AZURE_PROJECT = args['azure-project'];
const IN_PATH = args['in'] ?? 'scripts/pr-creator/prs.json';
const OUT_PATH = args['out'] ?? 'scripts/pr-creator/prs-azure.json';

if (!AZURE_ORG || !AZURE_PROJECT) {
    console.error(
        'ERROR: --azure-org and --azure-project are required.\n\n' +
            'Example:\n' +
            '  node scripts/benchmark/migrate-prs-to-azure.mjs \\\n' +
            '    --azure-org=myorg --azure-project=ai-code-review-benchmark',
    );
    process.exit(1);
}

// ---------- read ----------

const src = JSON.parse(readFileSync(IN_PATH, 'utf8'));
if (!src?.prs?.length) {
    console.error(`ERROR: ${IN_PATH} has no .prs array.`);
    process.exit(1);
}

// ---------- map ----------

/**
 * GitHub repo string -> Azure repo path.
 * GitHub form: "<owner>/<repo>"      e.g. "Wellington01/sentry-greptile"
 * Azure form:  "<org>/<project>/<repo>" e.g. "kodus/ai-code-review-benchmark/sentry-greptile"
 *
 * The `<repo>` segment is preserved (import script keeps the same name).
 */
function toAzureRepo(githubRepo) {
    const segments = githubRepo.split('/').filter(Boolean);
    const repoName = segments[segments.length - 1];
    if (!repoName) {
        throw new Error(`Cannot extract repo name from "${githubRepo}"`);
    }
    return `${AZURE_ORG}/${AZURE_PROJECT}/${repoName}`;
}

const out = {
    ...src,
    prs: src.prs.map((pr) => ({
        ...pr,
        repo: toAzureRepo(pr.repo),
        platform: 'azuredevops',
    })),
};

// ---------- write ----------

writeFileSync(OUT_PATH, JSON.stringify(out, null, 4) + '\n');

const byRepo = out.prs.reduce((acc, pr) => {
    acc[pr.repo] = (acc[pr.repo] || 0) + 1;
    return acc;
}, {});

console.log(`✅ Wrote ${out.prs.length} PRs to ${OUT_PATH}`);
console.log('   Per repo:');
for (const [repo, count] of Object.entries(byRepo)) {
    console.log(`     ${repo}: ${count}`);
}
console.log('');
console.log('Next: benchmark-create.sh --platform=azure <N>');
