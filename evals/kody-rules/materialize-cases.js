#!/usr/bin/env node
// Records, for each case of a kody-rules dataset, what the code host answers
// about its pull request, so the eval hands production the PR production would
// fetch: the PR (refs, title, body), every changed file as the GitHub adapter
// returns it (GithubService.getFilesByPullRequestId: filename, sha, status,
// additions, deletions, changes, patch) and its commits. The ground truth is
// read again from those patches (patterns.js), so it covers the same lines the
// review sees. The PRs are merged, so their diffs no longer move.
//
//   node evals/kody-rules/materialize-cases.js [--dataset=github-cases]
//
// Needs the gh CLI authenticated. Rewrites the dataset in place and prints, per
// case, the sites before and after.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PATTERNS, inScope, addedLines } = require('./patterns');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const file = path.join(__dirname, `${args.dataset || 'github-cases'}.json`);

const gh = (endpoint, paginate = false) =>
    JSON.parse(
        execFileSync('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), endpoint], {
            maxBuffer: 256 * 1024 * 1024,
        }).toString(),
    );

function fetchPr(repositoryFullName, number) {
    const pr = gh(`repos/${repositoryFullName}/pulls/${number}`);
    if (!pr.merged_at) throw new Error(`${repositoryFullName}#${number} is not merged: its diff can still move`);
    const files = gh(`repos/${repositoryFullName}/pulls/${number}/files?per_page=100`, true).flat();
    const commits = gh(`repos/${repositoryFullName}/pulls/${number}/commits?per_page=100`, true).flat();
    return {
        repositoryFullName,
        number,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
        defaultBranch: pr.base.repo.default_branch,
        title: pr.title,
        body: pr.body || '',
        files: files.map((f) => ({
            filename: f.filename,
            sha: f.sha ?? null,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            patch: f.patch,
        })),
        commits: commits.map((c) => ({ sha: c.sha, commit: { message: c.commit.message, author: { date: c.commit.author?.date } } })),
    };
}

// A case whose rule has no pattern here is a negative control: the rule must
// not fire anywhere in the PR (polyglot-cases: a Ruby rule over JS, CSS and
// templates), so every file of the PR is clean.
function groundTruth(pr, ruleUuid) {
    const spec = PATTERNS[ruleUuid];
    // A Ruby rule does apply to Ruby sources, whose hits take a judgment this
    // corpus has no answer for: they are not scored. Templates (.erb) are: the
    // incident's hits there were JavaScript.
    if (!spec) return { gt: {}, scoped: pr.files.filter((f) => f.patch && !/\.(rb|rake|gemspec|ru)$/.test(f.filename)).map((f) => f.filename) };
    const scoped = pr.files.filter(inScope);
    const gt = {};
    for (const f of scoped) {
        const sites = addedLines(f.patch)
            // A pattern inside a comment (a JSDoc example) is not a violation.
            .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l.code) && spec.rx.test(l.code))
            .map((l) => ({ line: l.line, code: l.code.trim().slice(0, 80) }));
        if (sites.length) gt[f.filename] = sites;
    }
    return { gt, scoped: scoped.map((f) => f.filename) };
}

function main() {
    const cases = JSON.parse(fs.readFileSync(file, 'utf8'));
    const prs = new Map();
    for (const c of cases) {
        const [repo, number] = String(c.caseId).split('::')[0].split('#');
        const key = `${repo}#${number}`;
        if (!prs.has(key)) {
            console.error(`fetching ${key}`);
            prs.set(key, fetchPr(repo, Number(number)));
        }
        const pr = prs.get(key);
        const sitesBefore = Object.values(c.groundTruth || {}).reduce((n, s) => n + s.length, 0);
        const { gt, scoped } = groundTruth(pr, c.rule.uuid);
        c.pr = pr;
        c.title = pr.title;
        c.body = pr.body;
        c.groundTruth = gt;
        c.violatingFiles = Object.keys(gt);
        c.cleanFiles = scoped.filter((f) => !gt[f]);
        delete c.realChangedFiles;
        delete c.toolReplay;
        const sitesAfter = Object.values(gt).reduce((n, s) => n + s.length, 0);
        console.log(`${c.caseId}: ${pr.files.length} files in the PR, ${scoped.length} scored; sites ${sitesBefore} → ${sitesAfter}`);
    }
    fs.writeFileSync(file, `${JSON.stringify(cases, null, 2)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
    return 0;
}

process.exit(main());
