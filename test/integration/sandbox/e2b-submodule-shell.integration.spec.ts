jest.mock('e2b', () => {
    class CommandExitError extends Error {
        stdout: string;
        stderr: string;
        exitCode: number;
        constructor(o: { stdout: string; stderr: string; exitCode: number }) {
            super('command exited non-zero');
            this.stdout = o.stdout;
            this.stderr = o.stderr;
            this.exitCode = o.exitCode;
        }
    }
    return { CommandExitError, Sandbox: class {} };
});

import { exec, execFile, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { CommandExitError } from 'e2b';
import { fetchE2BSubmodules } from '@libs/sandbox/infrastructure/providers/e2b-sandbox.service';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/**
 * #1939 — the E2B half of the submodule fix, against real git.
 *
 * The local provider passes its arguments to `execFile` (no shell); the E2B
 * provider builds a SHELL STRING and hands it to the sandbox. Nothing exercised
 * that string end to end, so quoting, flag order and `envs` propagation were
 * only ever asserted against a mock. A `--get-regexp` pattern or a scoped
 * config key mangled by the shell would have passed every unit test and failed
 * in production.
 *
 * So the fake sandbox here does what E2B does: run the command string through
 * a real shell and THROW CommandExitError on a non-zero exit. The one
 * substitution is the hardcoded `/home/user/repo`, rewritten to a temp dir —
 * everything else is the provider's own string, unmodified.
 */

function scrubbedGitEnv(
    overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv;
    for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('GIT_') && key !== 'GIT_EXEC_PATH') continue;
        env[key] = value;
    }
    return { ...env, ...overrides };
}

const GIT_ENV = {
    GIT_AUTHOR_NAME: 'kodus-test',
    GIT_AUTHOR_EMAIL: 'test@kodus.io',
    GIT_COMMITTER_NAME: 'kodus-test',
    GIT_COMMITTER_EMAIL: 'test@kodus.io',
};

const git = (args: string[]) =>
    execFileAsync('git', args, { env: scrubbedGitEnv(GIT_ENV) });

const SANDBOX_REPO_DIR = '/home/user/repo';

describe('E2B submodule fetch — the real command strings, against real git', () => {
    jest.setTimeout(120_000);

    let server: Server;
    let port: number;
    let serverRoot: string;
    let scratch: string;
    let foreignServer: Server;
    let foreignPort: number;
    let foreignAuthSeen: string[];
    /** Repo paths the token is not entitled to. */
    let denied: Set<string>;
    /** Every command string the provider built, verbatim. */
    let commands: string[];

    const AUTH = `Authorization: Basic ${Buffer.from(
        'x-access-token:SECRET',
    ).toString('base64')}`;

    /**
     * Stands in for an E2B sandbox: real shell, real exit codes, real env —
     * and the same CommandExitError contract the provider codes against.
     */
    const makeSandbox = (repoDir: string) =>
        ({
            commands: {
                run: async (
                    cmd: string,
                    opts?: { envs?: Record<string, string> },
                ) => {
                    commands.push(cmd);
                    const real = cmd.split(SANDBOX_REPO_DIR).join(repoDir);
                    try {
                        const { stdout, stderr } = await execAsync(real, {
                            env: scrubbedGitEnv({
                                ...GIT_ENV,
                                ...(opts?.envs ?? {}),
                            }) as any,
                        });
                        return { stdout, stderr, exitCode: 0 };
                    } catch (err: any) {
                        throw new CommandExitError({
                            stdout: err.stdout ?? '',
                            stderr: err.stderr ?? String(err),
                            exitCode: err.code ?? 1,
                        });
                    }
                },
            },
        }) as any;

    /** git-http-backend CGI bridge that REQUIRES the exact auth header. */
    const startGitServer = async (root: string) =>
        new Promise<{ server: Server; port: number }>((resolve) => {
            const srv = createServer((req, res) => {
                if (
                    [...denied].some((repo) =>
                        (req.url || '').startsWith(`/${repo}`),
                    )
                ) {
                    // Models a GitHub App installation set to "selected
                    // repositories" that leaves this submodule repo out.
                    res.writeHead(403);
                    res.end('not in this installation');
                    return;
                }
                if ((req.headers['authorization'] ?? '') !== AUTH.slice(15)) {
                    res.writeHead(401, {
                        'WWW-Authenticate': 'Basic realm="git"',
                    });
                    res.end('unauthorized');
                    return;
                }
                const [path, query = ''] = (req.url || '').split('?');
                const cgi = spawn(
                    join(process.env.GIT_EXEC_PATH || '', 'git-http-backend'),
                    [],
                    {
                        env: scrubbedGitEnv({
                            GIT_PROJECT_ROOT: root,
                            GIT_HTTP_EXPORT_ALL: '1',
                            PATH_INFO: path,
                            QUERY_STRING: query,
                            REQUEST_METHOD: req.method || 'GET',
                            CONTENT_TYPE: req.headers['content-type'] || '',
                        }),
                    },
                );
                req.pipe(cgi.stdin);
                let raw = Buffer.alloc(0);
                cgi.stdout.on('data', (c) => {
                    raw = Buffer.concat([raw, c]);
                });
                cgi.stdout.on('end', () => {
                    const sep = raw.indexOf('\r\n\r\n');
                    for (const line of raw
                        .subarray(0, sep)
                        .toString()
                        .split('\r\n')) {
                        const i = line.indexOf(':');
                        if (i > 0)
                            res.setHeader(
                                line.slice(0, i),
                                line.slice(i + 1).trim(),
                            );
                    }
                    res.end(raw.subarray(sep + 4));
                });
            });
            srv.listen(0, '127.0.0.1', () =>
                resolve({ server: srv, port: (srv.address() as any).port }),
            );
        });

    /** A host that is NOT the repository's, recording what it is offered. */
    const startForeignHost = async () =>
        new Promise<{ server: Server; port: number }>((resolve) => {
            const srv = createServer((req, res) => {
                foreignAuthSeen.push(
                    String(req.headers['authorization'] ?? '(none)'),
                );
                res.writeHead(404);
                res.end('x');
            });
            srv.listen(0, '127.0.0.1', () =>
                resolve({ server: srv, port: (srv.address() as any).port }),
            );
        });

    const publish = async (
        src: string,
        name: string,
        /**
         * Default false = a server that does NOT serve unadvertised objects,
         * which is what git-http-backend does out of the box and what many
         * self-hosted installs run.
         */
        allowAnySha = true,
    ) => {
        const bare = join(serverRoot, `${name}.git`);
        await git(['clone', '--bare', src, bare]);
        if (allowAnySha) {
            await git([
                '-C',
                bare,
                'config',
                'uploadpack.allowAnySHA1InWant',
                'true',
            ]);
        }
    };

    beforeAll(async () => {
        const { stdout } = await execFileAsync('git', ['--exec-path']);
        process.env.GIT_EXEC_PATH = stdout.trim();

        serverRoot = await mkdtemp(join(tmpdir(), 'kodus-e2b-server-'));
        scratch = await mkdtemp(join(tmpdir(), 'kodus-e2b-work-'));
        foreignAuthSeen = [];
        denied = new Set();

        ({ server, port } = await startGitServer(serverRoot));
        ({ server: foreignServer, port: foreignPort } =
            await startForeignHost());

        const sub = join(scratch, 'commons');
        await git(['init', '-b', 'main', sub]);
        await writeFile(
            join(sub, 'date.ts'),
            'export const coerceToDate = (v: unknown) => new Date(String(v));\n',
            'utf8',
        );
        await git(['-C', sub, 'add', '.']);
        await git(['-C', sub, 'commit', '-m', 'commons']);
        await publish(sub, 'commons');
        const { stdout: subSha } = await git(['-C', sub, 'rev-parse', 'HEAD']);

        const sub2 = join(scratch, 'brain');
        await git(['init', '-b', 'main', sub2]);
        await writeFile(
            join(sub2, 'brain.ts'),
            'export const b = 2;\n',
            'utf8',
        );
        await git(['-C', sub2, 'add', '.']);
        await git(['-C', sub2, 'commit', '-m', 'brain']);
        await publish(sub2, 'brain');
        const { stdout: sub2Sha } = await git([
            '-C',
            sub2,
            'rev-parse',
            'HEAD',
        ]);

        const buildSuper = async (name: string, submoduleUrl: string) => {
            const dir = join(scratch, name);
            await git(['init', '-b', 'main', dir]);
            await writeFile(
                join(dir, '.gitmodules'),
                `[submodule "commons-mod"]\n\tpath = packages/commons\n\turl = ${submoduleUrl}\n`,
                'utf8',
            );
            await writeFile(
                join(dir, 'app.ts'),
                'export const a = 1;\n',
                'utf8',
            );
            await git(['-C', dir, 'add', '.gitmodules', 'app.ts']);
            await git([
                '-C',
                dir,
                'update-index',
                '--add',
                '--cacheinfo',
                `160000,${subSha.trim()},packages/commons`,
            ]);
            await git(['-C', dir, 'commit', '-m', name]);
            await publish(dir, name);
        };

        await buildSuper('super', `http://127.0.0.1:${port}/commons.git`);
        await buildSuper('super-relative', '../commons.git');
        await buildSuper(
            'super-foreign',
            `http://127.0.0.1:${foreignPort}/commons.git`,
        );
        await buildSuper(
            'super-escape',
            '../../../../../../evil.example/commons.git',
        );

        // One legitimate submodule NEXT TO a broken one. `git submodule init`
        // is all-or-nothing, so before the per-path retry this fetched neither.
        {
            const dir = join(scratch, 'super-mixed');
            await git(['init', '-b', 'main', dir]);
            await writeFile(
                join(dir, '.gitmodules'),
                `[submodule "good"]\n\tpath = packages/commons\n\turl = http://127.0.0.1:${port}/commons.git\n` +
                    `[submodule "broken"]\n\tpath = packages/broken\n\turl = ../../../../../../evil.example/x.git\n`,
                'utf8',
            );
            await git(['-C', dir, 'add', '.gitmodules']);
            for (const p of ['packages/commons', 'packages/broken']) {
                await git([
                    '-C',
                    dir,
                    'update-index',
                    '--add',
                    '--cacheinfo',
                    `160000,${subSha.trim()},${p}`,
                ]);
            }
            await git(['-C', dir, 'commit', '-m', 'mixed']);
            await publish(dir, 'super-mixed');
        }

        // Two same-host submodules, both valid. The test denies ONE of them to
        // model an installation that covers `brain` but not `commons`.
        {
            const dir = join(scratch, 'super-two');
            await git(['init', '-b', 'main', dir]);
            await writeFile(
                join(dir, '.gitmodules'),
                `[submodule "commons-mod"]\n\tpath = packages/commons\n\turl = http://127.0.0.1:${port}/commons.git\n` +
                    `[submodule "brain-mod"]\n\tpath = packages/brain\n\turl = http://127.0.0.1:${port}/brain.git\n`,
                'utf8',
            );
            await git(['-C', dir, 'add', '.gitmodules']);
            await git([
                '-C',
                dir,
                'update-index',
                '--add',
                '--cacheinfo',
                `160000,${subSha.trim()},packages/commons`,
            ]);
            await git([
                '-C',
                dir,
                'update-index',
                '--add',
                '--cacheinfo',
                `160000,${sub2Sha.trim()},packages/brain`,
            ]);
            await git(['-C', dir, 'commit', '-m', 'two']);
            await publish(dir, 'super-two');
        }

        // A submodule pinned to a commit that is NOT the branch tip, served by
        // a repository that does not allow unadvertised-object fetches. This
        // is the ordinary state of a submodule: it is pinned, and upstream
        // moves on.
        {
            const pinned = join(scratch, 'pinned-sub');
            await git(['init', '-b', 'main', pinned]);
            await writeFile(
                join(pinned, 'pinned.ts'),
                'export const p = 1;\n',
                'utf8',
            );
            await git(['-C', pinned, 'add', '.']);
            await git(['-C', pinned, 'commit', '-m', 'first']);
            const { stdout: oldSha } = await git([
                '-C',
                pinned,
                'rev-parse',
                'HEAD',
            ]);
            for (const n of ['second', 'third']) {
                await writeFile(
                    join(pinned, 'pinned.ts'),
                    `export const p = '${n}';\n`,
                    'utf8',
                );
                await git(['-C', pinned, 'add', '.']);
                await git(['-C', pinned, 'commit', '-m', n]);
            }
            await publish(pinned, 'pinned-sub', false);

            const dir = join(scratch, 'super-pinned');
            await git(['init', '-b', 'main', dir]);
            await writeFile(
                join(dir, '.gitmodules'),
                `[submodule "pinned-mod"]\n\tpath = packages/pinned\n\turl = http://127.0.0.1:${port}/pinned-sub.git\n`,
                'utf8',
            );
            await git(['-C', dir, 'add', '.gitmodules']);
            await git([
                '-C',
                dir,
                'update-index',
                '--add',
                '--cacheinfo',
                `160000,${oldSha.trim()},packages/pinned`,
            ]);
            await git(['-C', dir, 'commit', '-m', 'pinned']);
            await publish(dir, 'super-pinned');
        }
    });

    afterAll(async () => {
        await new Promise<void>((r) => server?.close(() => r()));
        await new Promise<void>((r) => foreignServer?.close(() => r()));
        await rm(serverRoot, { recursive: true, force: true });
        await rm(scratch, { recursive: true, force: true });
    });

    beforeEach(() => {
        commands = [];
        foreignAuthSeen = [];
        denied = new Set();
    });

    /** Reproduce the E2B create path's checkout, then run the fix on it. */
    const checkout = async (repo: string, logger?: any) => {
        const dir = await mkdtemp(join(tmpdir(), 'kodus-e2b-repo-'));
        const cloneUrl = `http://127.0.0.1:${port}/${repo}.git`;
        await git(['init', dir]);
        await execFileAsync(
            'git',
            [
                '-C',
                dir,
                '-c',
                `http.extraHeader=${AUTH}`,
                'fetch',
                '--depth=1',
                cloneUrl,
                'refs/heads/main:pr-head',
            ],
            { env: scrubbedGitEnv(GIT_ENV) },
        );
        await git(['-C', dir, 'checkout', 'pr-head']);
        await fetchE2BSubmodules(makeSandbox(dir), cloneUrl, AUTH, { logger });
        return { dir, cloneUrl };
    };

    it('populates a same-host submodule through the real shell', async () => {
        const { dir } = await checkout('super');
        const file = await readFile(
            join(dir, 'packages', 'commons', 'date.ts'),
            'utf8',
        );
        expect(file).toContain('coerceToDate');
    });

    it('the `--get-regexp` pattern survives the shell', async () => {
        await checkout('super');
        // If the shell had eaten the backslashes or the `$`, the dump would
        // have matched nothing and no submodule would have been fetched.
        expect(
            commands.some((c) => c.includes("'^submodule\\..*\\.url$'")),
        ).toBe(true);
    });

    it('populates a RELATIVE url — proves `-c remote.origin.url=` survives too', async () => {
        const { dir } = await checkout('super-relative');
        const file = await readFile(
            join(dir, 'packages', 'commons', 'date.ts'),
            'utf8',
        );
        expect(file).toContain('coerceToDate');
    });

    it('the scoped auth header authenticates — it is what the server accepted', async () => {
        await checkout('super');
        // The server 401s anything without the exact header, so a mangled or
        // wrongly-scoped key could not have fetched the submodule above.
        expect(commands.some((c) => c.includes("'submodule' 'update'"))).toBe(
            true,
        );
        // ...and it never travels as a command argument.
        for (const c of commands) expect(c).not.toContain(AUTH);
    });

    it('never fetches a foreign-host submodule, and never offers it the token', async () => {
        const { dir } = await checkout('super-foreign');
        expect(await readdir(join(dir, 'packages', 'commons'))).toEqual([]);
        expect(foreignAuthSeen).toEqual([]);
        // Not vacuous: git DID register the url (init ran) and the provider
        // then removed it — assert the removal actually happened.
        expect(
            commands.some((c) =>
                c.includes("'--remove-section' 'submodule.commons-mod'"),
            ),
        ).toBe(true);
        // The refusal outlives the call.
        const { stdout } = await execFileAsync(
            'git',
            ['-C', dir, 'config', '--get', 'submodule.commons-mod.url'],
            { env: scrubbedGitEnv(GIT_ENV) },
        ).catch(() => ({ stdout: '' }) as any);
        expect(String(stdout).trim()).toBe('');
    });

    it('rejects an over-deep relative url, which git resolves off-host', async () => {
        const warn = jest.fn();
        const { dir } = await checkout('super-escape', { warn });
        expect(await readdir(join(dir, 'packages', 'commons'))).toEqual([]);
        // Not vacuous: the rejection is what git actually resolved, and the
        // reason names the non-http transport git produced.
        const skipped = warn.mock.calls
            .map(([a]: any[]) => a?.metadata?.skipped)
            .find(Boolean);
        expect(skipped).toEqual([
            expect.objectContaining({
                path: 'packages/commons',
                url: expect.stringContaining('evil.example/commons.git'),
                reason: expect.stringContaining('did not resolve'),
            }),
        ]);
    });

    it('one broken submodule does not stop the legitimate one next to it', async () => {
        // `git submodule init` aborts wholesale on an unresolvable url
        // (measured: `fatal: cannot strip one component off url '.'`, exit
        // 128), so without the per-path retry this repository fetched NOTHING.
        const { dir } = await checkout('super-mixed');
        expect(await readdir(join(dir, 'packages', 'commons'))).toContain(
            'date.ts',
        );
        expect(await readdir(join(dir, 'packages', 'broken'))).toEqual([]);
    });

    it('an inaccessible submodule does not block an accessible one', async () => {
        // `git submodule update` aborts at the first submodule it cannot
        // clone and never reaches the rest (measured), so a token that covers
        // `brain` but not `commons` would otherwise fetch NEITHER — exactly
        // the partial-installation case raised on the issue.
        denied = new Set(['commons.git']);
        const { dir } = await checkout('super-two');
        expect(await readdir(join(dir, 'packages', 'brain'))).toContain(
            'brain.ts',
        );
        expect(await readdir(join(dir, 'packages', 'commons'))).toEqual([]);
        // Not vacuous: one update per submodule is what makes this possible —
        // `commons` is attempted (shallow, then the full-history retry) and
        // `brain` is still reached afterwards.
        const updated = commands.filter((c) =>
            c.includes("'submodule' 'update'"),
        );
        expect(updated.some((c) => c.includes("'packages/commons'"))).toBe(
            true,
        );
        expect(updated.some((c) => c.includes("'packages/brain'"))).toBe(true);
        expect(
            updated.every(
                (c) =>
                    c.includes("'packages/commons'") ||
                    c.includes("'packages/brain'"),
            ),
        ).toBe(true);
    });

    it('populates a submodule pinned to a commit the server will not advertise', async () => {
        // `--depth=1` only gets the advertised tips. Measured against a
        // default git-http-backend: `error: Server does not allow request for
        // unadvertised object <sha>` and the directory is left EMPTY. The full
        // fetch fallback is what actually brings the pinned commit down.
        const { dir } = await checkout('super-pinned');
        const file = await readFile(
            join(dir, 'packages', 'pinned', 'pinned.ts'),
            'utf8',
        );
        // The PINNED content, not the tip.
        expect(file).toContain('export const p = 1;');
        // And it really took the fallback.
        expect(
            commands.some(
                (c) =>
                    c.includes("'submodule' 'update'") &&
                    !c.includes("'--depth=1'"),
            ),
        ).toBe(true);
    });

    it('a submodule NAME that differs from its PATH is handled', async () => {
        // `.gitmodules` names the section "commons-mod" but the path is
        // `packages/commons`: config is keyed by NAME, `submodule update` takes
        // the PATH. Mixing them up fetches nothing.
        const { dir } = await checkout('super');
        expect(await readdir(join(dir, 'packages', 'commons'))).toContain(
            'date.ts',
        );
    });
});
