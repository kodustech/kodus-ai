// Prepares a real working tree for one benchmark case: check out the PR's HEAD
// commit, so the agent greps/reads the code AS CHANGED, instead of replaying
// recorded tool calls.
//
// Head, not base+patch: the datasets store diffs in a Kodus-specific rendering
// (`## file:` / `__new hunk__` / line-number prefixes), not unified diff, so
// `git apply` cannot consume them. The head commit already IS base+diff, and
// every light case carries `benchmarkHeadRef` (10 Discourse cases have a null
// baseRef but a valid head). Falls back to `benchmarkBaseRef` when head is
// missing — a base tree still answers the cross-file searches, which is the
// point of running against a real repo.
//
// Worktrees, not checkouts: cases run in parallel and share one clone, so a
// plain `git checkout` would have them fighting over HEAD.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const BENCH_ROOT =
    process.env.BENCH_REPOS_ROOT ||
    path.join(process.env.HOME || '', 'projects/benchmark');

/** repositoryFullName (owner/name) → local clone directory. */
const REPO_DIRS = {
    'calcom/cal.com': 'cal.com',
    'getsentry/sentry': 'sentry',
    'keycloak/keycloak': 'keycloak',
    'grafana/grafana': 'grafana',
    'discourse/discourse': 'discourse',
    // Two sentry cases were extracted from a benchmark mirror. Every ref they
    // name (base and head) resolves inside the getsentry/sentry clone, so the
    // name-suffix fallback below ("sentry-greptile" != "sentry") would have
    // dropped them to replay for no reason.
    'ai-code-review-evaluation/sentry-greptile': 'sentry',
};

function repoDirFor(repositoryFullName) {
    const key = String(repositoryFullName || '').toLowerCase();
    for (const [full, dir] of Object.entries(REPO_DIRS)) {
        if (full.toLowerCase() === key) return path.join(BENCH_ROOT, dir);
    }
    // Fall back to matching just the repo name — dataset spellings vary.
    const name = key.split('/').pop();
    for (const [full, dir] of Object.entries(REPO_DIRS)) {
        if (full.split('/')[1].toLowerCase() === name) return path.join(BENCH_ROOT, dir);
    }
    return null;
}

async function git(repoDir, args, opts = {}) {
    return execFileAsync('git', ['-C', repoDir, ...args], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeout ?? 120_000,
        ...opts,
    });
}

/** GitHub URL in the dataset → the upstream we can fetch PR refs from. */
function upstreamFor(repositoryFullName) {
    const key = String(repositoryFullName || '').trim();
    return key.includes('/') ? `https://github.com/${key}.git` : null;
}

/** PR number from `benchmarkSourceUrl` (…/pull/10600), when the case came
 *  from a PR rather than a bare commit. */
function prNumberFrom(sourceUrl) {
    const m = String(sourceUrl || '').match(/\/pull\/(\d+)/);
    return m ? m[1] : null;
}

async function hasCommit(repoDir, sha) {
    try {
        await git(repoDir, ['cat-file', '-e', `${sha}^{commit}`]);
        return true;
    } catch {
        return false;
    }
}

/**
 * The commit to check out, best first:
 *   1. the PR's head — the code AS CHANGED, which is what we want to review;
 *   2. the base commit — cross-file callers are identical there (they live in
 *      files the PR doesn't touch), so selector-style searches still work; only
 *      re-reading a CHANGED file would show the pre-change version, and the diff
 *      for those is already in the agent's prompt.
 * A fork's PR head isn't in the clone, so fetch `refs/pull/N/head` from upstream
 * once when needed.
 */
async function resolveSha(repoDir, vars) {
    const head = vars.benchmarkHeadRef;
    if (head && (await hasCommit(repoDir, head))) return head;

    if (head) {
        const upstream = upstreamFor(vars.repositoryFullName);
        const pr = prNumberFrom(vars.benchmarkSourceUrl);
        if (upstream) {
            for (const refspec of [
                pr ? `refs/pull/${pr}/head` : null,
                head,
            ].filter(Boolean)) {
                try {
                    await git(repoDir, ['fetch', '--quiet', '--filter=blob:none', upstream, refspec], {
                        timeout: 300_000,
                    });
                    if (await hasCommit(repoDir, head)) return head;
                } catch {
                    /* try the next refspec */
                }
            }
        }
    }

    const base = vars.benchmarkBaseRef;
    if (base && (await hasCommit(repoDir, base))) return base;
    return null;
}

/**
 * @returns {Promise<{dir:string, cleanup:()=>Promise<void>, baseSha:string, applied:boolean}|null>}
 *   null when the repo/commit isn't available locally — caller falls back to replay.
 */
async function prepareRepo(vars, caseId) {
    const repoDir = repoDirFor(vars.repositoryFullName);
    if (!repoDir || !fs.existsSync(repoDir)) return null;

    const sha = await resolveSha(repoDir, vars);
    if (!sha) return null;

    const wtDir = path.join(
        BENCH_ROOT,
        '.worktrees',
        `${path.basename(repoDir)}-${String(caseId).slice(0, 40)}-${process.pid}`,
    );
    fs.mkdirSync(path.dirname(wtDir), { recursive: true });

    try {
        await git(repoDir, ['worktree', 'add', '--detach', '--force', wtDir, sha], {
            timeout: 300_000,
        });
    } catch {
        return null;
    }

    const cleanup = async () => {
        try {
            await git(repoDir, ['worktree', 'remove', '--force', wtDir], { timeout: 60_000 });
        } catch {
            try {
                fs.rmSync(wtDir, { recursive: true, force: true });
            } catch {}
        }
    };

    return { dir: wtDir, cleanup, sha };
}

module.exports = { prepareRepo, repoDirFor, BENCH_ROOT };
