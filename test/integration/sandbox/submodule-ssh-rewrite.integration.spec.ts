import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { sshRewriteFor } from '@libs/sandbox/infrastructure/providers/submodule-fetch';

const execFileAsync = promisify(execFile);

/**
 * #1939 — `.gitmodules` very often carries `git@host:org/x.git`. ssh has
 * neither the scoped auth header nor the proxy, so such a submodule is
 * fetched by rewriting it onto https with `url.<https>.insteadOf`, same host
 * only.
 *
 * This file pins, against real git, that a pair of the shape the plan emits
 * actually makes git fetch a submodule whose registered url is scp-like —
 * which it does not without one. That the plan emits the pair as CONFIG
 * (never as an argument) is covered in submodule-fetch.spec.ts.
 */
const GIT_ENV = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: '/nonexistent',
};
// Without the scrub, GIT_DIR from a git hook sends these commits and pushes to
// the caller's repository instead of the temp ones.
function scrubbedGitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('GIT_') && key !== 'GIT_EXEC_PATH') continue;
        env[key] = value;
    }
    return env;
}

const git = (args: string[], cwd?: string) =>
    execFileAsync('git', args, {
        cwd,
        env: { ...scrubbedGitEnv(), ...GIT_ENV },
    } as any);

const maybe =
    process.env.SKIP_INTEGRATION === 'true' ? describe.skip : describe;

maybe('an ssh submodule is fetched over https', () => {
    let scratch: string;

    beforeAll(async () => {
        scratch = await mkdtemp(join(tmpdir(), 'kodus-ssh-rewrite-'));
    });
    afterAll(async () => {
        await rm(scratch, { recursive: true, force: true });
    });

    it('git fetches a scp-like submodule ONLY with the rewrite', async () => {
        // Laid out so the rewritten url lands on it: the prefix
        // `git@example.invalid:` is replaced by `<remotes>/`, and the rest of
        // the scp url (`acme/commons.git`) is kept — exactly as
        // `git@github.com:acme/x.git` becomes `https://github.com/acme/x.git`.
        const remotes = join(scratch, 'remotes');
        const bare = join(remotes, 'acme', 'commons.git');
        await git(['init', '-q', '--bare', bare]);
        const work = join(scratch, 'work');
        await git(['init', '-q', work]);
        await writeFile(join(work, 'date.ts'), 'export const x = 1;\n', 'utf8');
        await git(['add', '.'], work);
        await git(
            ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'c'],
            work,
        );
        await git(['push', '-q', bare, 'HEAD:refs/heads/main'], work);
        const { stdout: sha } = await git(['rev-parse', 'HEAD'], work);

        const superDir = join(scratch, 'super');
        await git(['init', '-q', '-b', 'main', superDir]);
        await writeFile(
            join(superDir, '.gitmodules'),
            '[submodule "commons"]\n\tpath = vendor/commons\n\turl = git@example.invalid:acme/commons.git\n',
            'utf8',
        );
        await git(['add', '.gitmodules'], superDir);
        await git(
            [
                'update-index',
                '--add',
                '--cacheinfo',
                `160000,${sha.trim()},vendor/commons`,
            ],
            superDir,
        );
        await git(
            ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 's'],
            superDir,
        );
        await git(
            [
                '-c',
                'remote.origin.url=https://example.invalid/acme/app.git',
                'submodule',
                'init',
            ],
            superDir,
        );

        // git registers the scp-like url verbatim.
        const { stdout: registered } = await git(
            ['config', '--get', 'submodule.commons.url'],
            superDir,
        );
        expect(registered.trim()).toBe('git@example.invalid:acme/commons.git');

        // Without a rewrite there is no fetch at all.
        await expect(
            git(['submodule', 'update', '--', 'vendor/commons'], superDir),
        ).rejects.toThrow();

        // The shape `sshRewriteFor` builds, pointed at a reachable url — the
        // same GIT_CONFIG_* channel the plan uses for the auth header.
        const shape = sshRewriteFor(
            'git@example.invalid:acme/commons.git',
            'https://example.invalid/acme/app.git',
        );
        expect(shape).toEqual({
            key: 'url.https://example.invalid/.insteadOf',
            value: 'git@example.invalid:',
        });

        await execFileAsync(
            'git',
            ['submodule', 'update', '--', 'vendor/commons'],
            {
                cwd: superDir,
                env: {
                    ...scrubbedGitEnv(),
                    ...GIT_ENV,
                    // Two pairs on the same channel the plan uses. The second
                    // is test scaffolding only: git refuses the `file`
                    // transport for submodules (CVE-2022-39253) and the stand-in
                    // for the remote here is a local bare repo. Production
                    // rewrites onto https, which needs no such opt-in.
                    GIT_CONFIG_COUNT: '2',
                    GIT_CONFIG_KEY_0: `url.${remotes}/.insteadOf`,
                    GIT_CONFIG_VALUE_0: shape!.value,
                    GIT_CONFIG_KEY_1: 'protocol.file.allow',
                    GIT_CONFIG_VALUE_1: 'always',
                },
            } as any,
        );

        const { stdout: head } = await git(
            ['rev-parse', 'HEAD'],
            join(superDir, 'vendor', 'commons'),
        );
        expect(head.trim()).toBe(sha.trim());
    }, 60_000);
});
