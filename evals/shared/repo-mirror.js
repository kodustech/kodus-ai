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

/**
 * The mirror of `repo` (owner/name) holding the case's head (refs/pull/<n>/head
 * for a PR, the commit itself otherwise) and its base branch. Returns the
 * file:// URL the sandbox clones from.
 */
async function mirrorFor({ repo, prNumber, headSha, baseRef }) {
    const dir = path.join(ROOT, `${repo.replace('/', '__')}.git`);
    const upstream = `https://github.com/${repo}.git`;
    return serial(dir, async () => {
        await ensureBare(dir);
        const headRef = prNumber ? `refs/pull/${prNumber}/head` : `refs/eval/${headSha}`;
        if (!(await hasRef(dir, headRef, headSha))) {
            const source = prNumber ? headRef : headSha;
            await git(dir, ['fetch', '-q', '--depth=1', upstream, `+${source}:${headRef}`]);
            if (headSha && !(await hasRef(dir, headRef, headSha))) {
                const { stdout } = await git(dir, ['rev-parse', headRef]);
                throw new Error(`${repo} ${headRef} is ${stdout.trim()}, the case reviews ${headSha}`);
            }
        }
        if (baseRef && !(await hasRef(dir, `refs/heads/${baseRef}`))) {
            await git(dir, ['fetch', '-q', '--depth=1', upstream, `+refs/heads/${baseRef}:refs/heads/${baseRef}`]);
        }
        return `file://${dir}`;
    });
}

/**
 * A repository written for an eval, as a mirror: every file of `files` on
 * `branch`, and `base` as its base branch, holding `baseFiles` (the tree before
 * the pull request) or, without them, the same tree. Returns the URL and a
 * cleanup.
 */
async function inlineMirror(files, { branch = 'feature', base = 'main', baseFiles } = {}) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-inline-mirror-'));
    const write = (tree) => {
        for (const [file, content] of Object.entries(tree || {})) {
            const target = path.join(work, file);
            if (!target.startsWith(work + path.sep)) throw new Error(`repoFiles path escapes the repository: ${file}`);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, String(content));
        }
    };
    try {
        const author = { GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
        await git(work, ['init', '-q', '-b', base]);
        if (baseFiles) {
            // The base branch before the pull request, then its head on `branch`.
            write(baseFiles);
            await git(work, ['add', '-A']);
            await git(work, ['commit', '-q', '--allow-empty', '-m', 'base of the pull request'], { env: author });
            await git(work, ['checkout', '-q', '-b', branch]);
            await git(work, ['rm', '-r', '-q', '--ignore-unmatch', '.']);
            write(files);
            await git(work, ['add', '-A']);
            await git(work, ['commit', '-q', '--allow-empty', '-m', 'head of the pull request'], { env: author });
        } else {
            write(files);
            await git(work, ['add', '-A']);
            await git(work, ['commit', '-q', '-m', 'head of the pull request'], { env: author });
            await git(work, ['branch', branch]);
        }
        await git(work, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    } catch (error) {
        fs.rmSync(work, { recursive: true, force: true });
        throw error;
    }
    return { cloneUrl: `file://${work}`, branch, base, cleanup: async () => fs.rmSync(work, { recursive: true, force: true }) };
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

/**
 * The pull request's changed files as the platform's API lists them for a
 * repository written for an eval (the GitHub adapter's shape: filename, status,
 * additions, deletions, changes, and `patch`, the unified diff of the file
 * without its header lines), read from the mirror between `base` and `head`.
 */
async function pullRequestFiles(cloneUrl, base, head) {
    const dir = cloneUrl.replace(/^file:\/\//, '');
    const STATUS = { A: 'added', M: 'modified', D: 'removed', R: 'renamed' };
    const { stdout: names } = await git(dir, ['diff', '--name-status', '--no-renames', `${base}..${head}`]);
    const { stdout: counts } = await git(dir, ['diff', '--numstat', '--no-renames', `${base}..${head}`]);
    const numstat = new Map(
        counts
            .split('\n')
            .filter(Boolean)
            .map((l) => {
                const [add, del, file] = l.split('\t');
                return [file, { additions: Number(add) || 0, deletions: Number(del) || 0 }];
            }),
    );
    const files = [];
    for (const line of names.split('\n').filter(Boolean)) {
        const [code, filename] = line.split('\t');
        const { stdout: diff } = await git(dir, ['diff', '-U3', '--no-renames', `${base}..${head}`, '--', filename]);
        const at = diff.indexOf('\n@@');
        const patch = at >= 0 ? diff.slice(at + 1).replace(/\n$/, '') : '';
        const n = numstat.get(filename) || { additions: 0, deletions: 0 };
        files.push({ filename, status: STATUS[code[0]] || 'modified', additions: n.additions, deletions: n.deletions, changes: n.additions + n.deletions, patch });
    }
    return files;
}

module.exports = { mirrorFor, inlineMirror, contentAt, pullRequestFiles, MIRROR_ROOT: ROOT };
