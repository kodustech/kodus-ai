// A local bare mirror of a public repository, holding the refs a case
// reviews, so production's sandbox (LocalSandboxService.createSandboxWithRepo)
// clones from it exactly as it clones from the platform: same refspecs, same
// shallow fetches, from a file:// URL. The mirror is data: it holds what
// GitHub holds for those refs, fetched once and kept between runs (CI caches
// the directory, EVAL_REPO_CACHE).
//
// A repository written for an eval (repoFiles) becomes a one-branch mirror the
// same way, so every eval's tools run on production's sandbox.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const ROOT = process.env.EVAL_REPO_CACHE || path.join(os.homedir(), '.cache', 'kodus-evals', 'repos');

// git without the variables that point it at another repository (a hook's
// GIT_DIR), as the sandbox itself runs git (local-sandbox.service.ts sandboxEnv).
function gitEnv(extra = {}) {
    const env = { ...process.env, ...extra };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']) delete env[key];
    return env;
}
const git = (dir, args, opts = {}) =>
    execFileAsync('git', ['-C', dir, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 15 * 60_000, env: gitEnv(opts.env) });

// One fetch at a time per mirror: concurrent fetches into one repository fight
// over its lock files.
const queues = new Map();
function serial(key, fn) {
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    queues.set(key, next.catch(() => undefined));
    return next;
}

async function hasRef(dir, ref, sha) {
    try {
        const { stdout } = await git(dir, ['rev-parse', '--verify', `${ref}^{commit}`]);
        return !sha || stdout.trim() === sha;
    } catch {
        return false;
    }
}

async function ensureBare(dir) {
    if (fs.existsSync(path.join(dir, 'HEAD'))) return;
    fs.mkdirSync(dir, { recursive: true });
    await git(dir, ['init', '--bare', '-q']);
    // The sandbox fetches by SHA on the CLI path (checkoutSha).
    await git(dir, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
}

async function fetchInto(dir, upstream, source, ref, sha) {
    if (await hasRef(dir, ref, sha)) return;
    await git(dir, ['fetch', '-q', '--depth=1', upstream, `+${source}:${ref}`]);
    if (sha && !(await hasRef(dir, ref, sha))) {
        const { stdout } = await git(dir, ['rev-parse', ref]);
        throw new Error(`${upstream} ${source} is ${stdout.trim()}, the case reviews ${sha}`);
    }
}

/**
 * The repository of a case as the platform held it when the PR was reviewed:
 * its head (refs/pull/<n>/head for a PR, the commit itself otherwise) and its
 * base branch at the PR's base commit, not the branch's tip today. Production
 * fetches the base branch's tip at review time, which for a PR under review is
 * its base commit.
 *
 * The objects live in one mirror per repository; each case gets a view of it
 * (a bare repository borrowing those objects) whose refs are that case's, so
 * two cases of one repository can each have their own base. Returns the
 * file:// URL the sandbox clones from.
 */
async function mirrorFor({ repo, prNumber, headSha, baseRef, baseSha }) {
    const name = repo.replace('/', '__');
    const dir = path.join(ROOT, `${name}.git`);
    const upstream = `https://github.com/${repo}.git`;
    const headRef = prNumber ? `refs/pull/${prNumber}/head` : `refs/eval/${headSha}`;
    return serial(dir, async () => {
        await ensureBare(dir);
        await fetchInto(dir, upstream, prNumber ? headRef : headSha, headSha ? `refs/eval/${headSha}` : headRef, headSha);
        if (baseRef && baseSha) await fetchInto(dir, upstream, baseSha, `refs/eval/${baseSha}`, baseSha);
        else if (baseRef) await fetchInto(dir, upstream, `refs/heads/${baseRef}`, `refs/heads/${baseRef}`);

        const view = path.join(ROOT, `${name}.views`, `${prNumber || headSha}.git`);
        await ensureBare(view);
        fs.writeFileSync(path.join(view, 'objects', 'info', 'alternates'), `${path.join(dir, 'objects')}\n`);
        const resolve = async (ref) => (await git(dir, ['rev-parse', ref])).stdout.trim();
        await git(view, ['update-ref', headRef, headSha || (await resolve(headRef))]);
        if (baseRef) await git(view, ['update-ref', `refs/heads/${baseRef}`, baseSha || (await resolve(`refs/heads/${baseRef}`))]);
        return `file://${view}`;
    });
}

/**
 * A repository written for an eval, as a mirror: `base` committed on the base
 * branch, `head` on the PR's branch on top of it (a file `head` maps to null is
 * deleted there). Returns the URL, the branches and a cleanup.
 */
async function inlineMirror(head, { base = {}, branch = 'feature', baseBranch = 'main' } = {}) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-inline-mirror-'));
    const author = { GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
    const write = (files) => {
        for (const [file, content] of Object.entries(files || {})) {
            const target = path.join(work, file);
            if (!target.startsWith(work + path.sep)) throw new Error(`repoFiles path escapes the repository: ${file}`);
            if (content === null) {
                fs.rmSync(target, { force: true });
                continue;
            }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, String(content));
        }
    };
    try {
        await git(work, ['init', '-q', '-b', baseBranch]);
        write(base);
        await git(work, ['add', '-A']);
        await git(work, ['commit', '-q', '--allow-empty', '-m', 'base of the pull request'], { env: author });
        await git(work, ['checkout', '-q', '-b', branch]);
        write(head);
        await git(work, ['add', '-A']);
        await git(work, ['commit', '-q', '--allow-empty', '-m', 'head of the pull request'], { env: author });
        await git(work, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    } catch (error) {
        fs.rmSync(work, { recursive: true, force: true });
        throw error;
    }
    return { cloneUrl: `file://${work}`, branch, base: baseBranch, cleanup: async () => fs.rmSync(work, { recursive: true, force: true }) };
}

/**
 * The PR's changed files between two trees, in the shape the GitHub adapter
 * returns them (GithubService.getFilesByPullRequestId): what the platform
 * computes for a pushed branch, computed here for a repository written for an
 * eval.
 */
function filesBetween(base = {}, head = {}) {
    const { createPatch } = require('diff');
    const names = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort();
    const files = [];
    for (const filename of names) {
        const before = base[filename] ?? null;
        const after = filename in head ? head[filename] : before;
        if (before === after) continue;
        // createPatch's header (Index, ===, ---, +++) is not in the platform's patch.
        const patch = createPatch(filename, before ?? '', after ?? '').split('\n').slice(4).join('\n').replace(/\n$/, '');
        const lines = patch.split('\n');
        const additions = lines.filter((l) => l.startsWith('+')).length;
        const deletions = lines.filter((l) => l.startsWith('-')).length;
        files.push({
            filename,
            sha: null,
            status: before === null ? 'added' : after === null ? 'removed' : 'modified',
            additions,
            deletions,
            changes: additions + deletions,
            patch,
        });
    }
    return files;
}

// A file as the platform's content API returns it for a ref (base64), read
// from the mirror holding that ref; null where the repository has no such file.
async function contentAt(cloneUrl, ref, filePath) {
    const dir = cloneUrl.replace(/^file:\/\//, '');
    try {
        const { stdout } = await execFileAsync('git', ['-C', dir, 'show', `${ref}:${filePath}`], {
            encoding: 'buffer',
            maxBuffer: 64 * 1024 * 1024,
            env: gitEnv(),
        });
        return { data: { content: Buffer.from(stdout).toString('base64'), encoding: 'base64' } };
    } catch {
        return null;
    }
}

module.exports = { mirrorFor, inlineMirror, filesBetween, contentAt, MIRROR_ROOT: ROOT };
