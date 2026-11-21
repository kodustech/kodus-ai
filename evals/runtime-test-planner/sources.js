// What the Git platform answers for one case, in the shapes production's
// CodeManagementService returns them (code-management-git.adapter.ts reads
// getFilesByPullRequestId, getFileContentAtRef and getRepositoryAllFiles). The
// adapter, the diff it builds, GitRepoReader and every read the planner makes
// stay production's: this file only supplies the repository.
//
// - `github`: a real pull request, read from GitHub's REST API with the token of
//   the `gh` CLI (kept in memory, never printed), cached on disk by commit so a
//   rerun reads nothing twice.
// - `fixture`: a small repository written for the eval (fixtures/<id>/base and
//   fixtures/<id>/head, head holding only the changed files), its patch from
//   `git diff --no-index`.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CACHE = path.join(os.homedir(), '.cache', 'kodus-evals', 'runtime-test-planner');
const API = 'https://api.github.com';

let token;
function githubToken() {
    if (token === undefined) {
        try {
            token = execFileSync('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
        } catch {
            token = null;
        }
    }
    if (!token) throw new Error('no GitHub token: `gh auth login` gives the eval read access to the case repository');
    return token;
}

function cached(key, fetcher) {
    const file = path.join(CACHE, 'github', crypto.createHash('sha1').update(key).digest('hex'));
    if (fs.existsSync(file)) return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8')).value);
    return fetcher().then((value) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ key, value }));
        return value;
    });
}

async function gh(pathname, { raw = false } = {}) {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${API}${pathname}`, {
            headers: {
                authorization: `Bearer ${githubToken()}`,
                accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
                'x-github-api-version': '2022-11-28',
            },
            signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 404) return null;
        if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < 3) {
            await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
            continue;
        }
        if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${pathname.split('?')[0]}`);
        return raw ? res.text() : res.json();
    }
}

/** The repository of a real pull request on GitHub, pinned to the case's commits. */
function githubSource({ repo, pr, baseSha, headSha }) {
    const files = () =>
        cached(`${repo}#${pr}@${headSha}:files`, async () => {
            const out = [];
            for (let page = 1; page < 30; page++) {
                const batch = await gh(`/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
                if (!batch?.length) break;
                out.push(...batch.map((f) => ({ filename: f.filename, patch: f.patch, status: f.status, previous_filename: f.previous_filename })));
                if (batch.length < 100) break;
            }
            return out;
        });
    const tree = (sha) =>
        cached(`${repo}@${sha}:tree`, async () => {
            const t = await gh(`/repos/${repo}/git/trees/${sha}?recursive=1`);
            if (!t) throw new Error(`no tree for ${repo}@${sha}`);
            if (t.truncated) throw new Error(`GitHub truncated the tree of ${repo}@${sha}`);
            return t.tree.filter((e) => e.type === 'blob').map((e) => e.path);
        });
    const read = (sha, p) =>
        cached(`${repo}@${sha}:${p}`, () => gh(`/repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`, { raw: true }));
    return { files, tree, read, check: () => checkPins({ repo, pr, baseSha, headSha }) };
}

/** A pull request whose head or base moved since the ground truth was written measures another change. */
async function checkPins({ repo, pr, baseSha, headSha }) {
    const live = await cached(`${repo}#${pr}:pins@${headSha}`, async () => {
        const p = await gh(`/repos/${repo}/pulls/${pr}`);
        return p ? { head: p.head.sha, base: p.base.sha } : null;
    });
    if (!live) throw new Error(`${repo}#${pr} not found`);
    if (live.head !== headSha) throw new Error(`${repo}#${pr} head is ${live.head.slice(0, 10)}, the case pins ${headSha.slice(0, 10)}`);
}

function walk(dir, prefix = '') {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel];
    });
}

/** A repository written for the eval: base/ is the base commit, head/ the changed files after the change. */
function fixtureSource(dir) {
    const base = path.join(dir, 'base');
    const head = path.join(dir, 'head');
    const changed = walk(head);
    const patchOf = (rel) => {
        const a = path.join(base, rel);
        const b = path.join(head, rel);
        let out = '';
        try {
            execFileSync('git', ['diff', '--no-index', '--no-color', '-U3', fs.existsSync(a) ? a : '/dev/null', b], { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) {
            // git diff --no-index exits 1 when the files differ.
            out = e.stdout ? e.stdout.toString() : '';
        }
        // GitHub's `patch`: the hunks only, from the first @@.
        const i = out.indexOf('\n@@');
        return i >= 0 ? out.slice(i + 1).replace(/\n$/, '') : '';
    };
    const read = (side, p) => {
        const file = path.join(side === 'head' && changed.includes(p) ? head : base, p);
        return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null;
    };
    return {
        files: async () => changed.map((p) => ({ filename: p, patch: patchOf(p), status: fs.existsSync(path.join(base, p)) ? 'modified' : 'added' })),
        tree: async (sha) => [...new Set([...walk(base), ...(sha === 'head' ? changed : [])])].sort(),
        read: async (sha, p) => read(sha, p),
        check: async () => undefined,
        baseFiles: () => walk(base),
        readBase: (p) => read('base', p),
    };
}

/**
 * The slice of CodeManagementService the Runtime's Git adapter calls, over
 * one case's source. A file over maxBytes is an error, never a cut, as the
 * platform answers it (git-repo-reader.ts GIT_READ_MAX_BYTES).
 */
function codeManagementOver(source, shas) {
    const shaOf = (ref) => (ref === shas.head ? shas.headRef : ref === shas.base ? shas.baseRef : ref);
    return {
        getPullRequest: async () => {
            await source.check();
            return {
                head: { sha: shas.head, ref: shas.headRef, repo: { id: 'eval-repository' } },
                base: { sha: shas.base, ref: shas.baseRef, repo: { id: 'eval-repository' } },
                state: 'open', draft: false,
            };
        },
        getFilesByPullRequestId: async () => source.files(),
        getFileContentAtRef: async ({ path: p, ref, maxBytes }) => {
            const text = await source.read(shaOf(ref), p);
            if (text === null || text === undefined) return null;
            if (maxBytes && Buffer.byteLength(text) > maxBytes) throw new Error(`file larger than ${maxBytes} bytes`);
            return text;
        },
        getRepositoryAllFiles: async ({ filters }) => (await source.tree(shaOf(filters.branch))).map((p) => ({ path: p })),
    };
}

module.exports = { githubSource, fixtureSource, codeManagementOver };
