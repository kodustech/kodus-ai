// A pull request as a git remote: a bare repository carrying the base branch
// and the PR head under the ref GitHub serves it at (refs/pull/<n>/head), so
// production's sandbox fetches it as it fetches GitHub (LocalSandboxService
// createSandboxWithRepo: `git fetch --depth=1 <remote> refs/pull/<n>/head`).
//
// The base holds every file but the ones the PR changes; the head adds them in
// one commit. A case gives the files at the head and which of them the PR
// changed; with no earlier version of a changed file there is nothing truer to
// put on the base. Dates are fixed, so the shas are the same on every run.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DATE = '2026-10-16T10:00:00Z';

function writePullRequestRemote({ files, changed, number = 7, base = 'main', head = 'feature', message = 'head of the pull request' }) {
    const { sandboxEnv } = require('../../libs/sandbox/infrastructure/providers/local-sandbox.service.ts');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-pr-'));
    const work = path.join(root, 'work');
    const remote = path.join(root, 'remote.git');
    // sandboxEnv drops GIT_DIR and the other variables that outrank -C: run from
    // a git hook, git would otherwise work on the caller's repository.
    const env = sandboxEnv({ GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com', GIT_AUTHOR_DATE: DATE, GIT_COMMITTER_DATE: DATE });
    const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { env, encoding: 'utf8' }).trim();
    const write = (only) => {
        for (const [file, content] of Object.entries(files)) {
            if (!only(file)) continue;
            fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
            fs.writeFileSync(path.join(work, file), content);
        }
    };
    fs.mkdirSync(work);
    git(work, 'init', '-q', '-b', base);
    write((file) => !changed.includes(file));
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'base');
    git(work, 'checkout', '-q', '-b', head);
    write((file) => changed.includes(file));
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', message);
    git(root, 'init', '-q', '--bare', remote);
    git(work, 'push', '-q', remote, `${base}:refs/heads/${base}`, `${head}:refs/heads/${head}`, `${head}:refs/pull/${number}/head`);
    return {
        remote,
        number,
        base,
        head,
        message,
        baseSha: git(remote, 'rev-parse', `refs/heads/${base}`),
        headSha: git(remote, 'rev-parse', `refs/pull/${number}/head`),
        date: DATE,
        git: (...a) => git(remote, ...a),
        // A blob's bytes, untrimmed.
        read: (spec) => execFileSync('git', ['-C', remote, 'show', spec], { env }),
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
}

module.exports = { writePullRequestRemote };
