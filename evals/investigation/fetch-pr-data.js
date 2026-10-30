#!/usr/bin/env node
// Records, once, what production's GitHub adapter hands the review for each
// finder case: the PR's changed files (GithubService.getFilesByPullRequestId)
// and commits (GithubService.getCommitsForPullRequestForCodeReview), in the
// adapter's own output shape, plus the PR's head and base. The review then
// starts from the same platform data production starts from: the raw `patch`
// the line anchoring reads, rendered by production's FetchChangedFilesStage
// at run time, and the commits the prompt carries.
//
//   node evals/investigation/fetch-pr-data.js [--cases=<id,id>] [--force]
//
// Needs `gh` authenticated (public repositories; the API's rate limit is the
// only reason it is not anonymous). A case whose source is a commit, not a PR
// (benchmarkSourceUrl …/commit/<sha>), records the compare between its base
// and head refs, which carries the same file and commit shapes.
//
// Writes `prFiles`, `prCommits`, `prHead`, `prBase` and `prNumber` into each
// dataset's vars, leaving every other field as it was.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, 'datasets');
const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const only = args.cases ? new Set(String(args.cases).split(',')) : null;

function gh(route, { paginate = false } = {}) {
    const out = execFileSync('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), route], {
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
    });
    const parsed = JSON.parse(out);
    return paginate ? parsed.flat() : parsed;
}

// GithubService.getFilesByPullRequestId's mapping of a listFiles entry.
const asAdapterFile = (file) => ({
    filename: file.filename,
    sha: file?.sha ?? null,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch,
});

// GithubService.getCommitsForPullRequestForCodeReview's mapping and order.
const asAdapterCommits = (commits) =>
    commits
        .map((commit) => ({
            sha: commit?.sha,
            created_at: commit?.commit?.author?.date,
            message: commit?.commit?.message,
            author: { id: commit?.author?.id, ...commit?.commit?.author, username: commit?.author?.login },
            parents: commit?.parents?.map((p) => ({ sha: p?.sha ?? '' }))?.filter((p) => p.sha) ?? [],
        }))
        .sort((a, b) => new Date(a?.author?.date).getTime() - new Date(b?.author?.date).getTime());

function fetchCase(vars) {
    const repo = String(vars.repositoryFullName || '');
    const source = String(vars.benchmarkSourceUrl || '');
    const pr = source.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (pr) {
        const [, fullName, number] = pr;
        const head = gh(`repos/${fullName}/pulls/${number}`);
        return {
            prNumber: Number(number),
            prHead: { ref: head.head?.ref, sha: head.head?.sha, repo: head.head?.repo?.full_name ?? null },
            prBase: { ref: head.base?.ref, sha: head.base?.sha, repo: fullName },
            prFiles: gh(`repos/${fullName}/pulls/${number}/files?per_page=100`, { paginate: true }).map(asAdapterFile),
            prCommits: asAdapterCommits(gh(`repos/${fullName}/pulls/${number}/commits?per_page=100`, { paginate: true })),
        };
    }
    // A commit: its parent is the base (the datasets of these cases carry no
    // base ref), the commit the head.
    const commitSha = (source.match(/\/commit\/([0-9a-f]{7,40})/) || [])[1] || vars.benchmarkHeadRef;
    if (!commitSha) throw new Error('no PR, no commit and no head ref to compare');
    const headSha = gh(`repos/${repo}/commits/${commitSha}`).sha;
    const baseSha = vars.benchmarkBaseRef || gh(`repos/${repo}/commits/${headSha}`).parents?.[0]?.sha;
    if (!baseSha) throw new Error(`no base for ${headSha}`);
    const compare = gh(`repos/${repo}/compare/${baseSha}...${headSha}`);
    return {
        prNumber: null,
        prHead: { ref: null, sha: headSha, repo },
        prBase: { ref: null, sha: baseSha, repo },
        prFiles: (compare.files || []).map(asAdapterFile),
        prCommits: asAdapterCommits(compare.commits || []),
    };
}

let written = 0;
let failed = 0;
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
    const full = path.join(DIR, file);
    const raw = fs.readFileSync(full, 'utf8');
    const data = JSON.parse(raw);
    const entry = Array.isArray(data) ? data[0] : data;
    const vars = entry?.vars;
    if (!vars?.caseId || !vars.repositoryFullName || String(vars.repositoryFullName).startsWith('eval/')) continue;
    if (only && !only.has(vars.caseId)) continue;
    if (vars.prFiles && !args.force) continue;
    try {
        Object.assign(vars, fetchCase(vars));
        fs.writeFileSync(full, JSON.stringify(data, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
        written += 1;
        console.log(`${vars.caseId}: ${JSON.parse(JSON.stringify(vars.prFiles)).length} files, ${vars.prCommits.length} commits`);
    } catch (error) {
        failed += 1;
        console.error(`${vars.caseId}: ${String(error.message || error).slice(0, 200)}`);
    }
}
console.log(`wrote ${written} datasets, ${failed} failed`);
process.exit(failed ? 2 : 0);
