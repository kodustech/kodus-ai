import { spawn, execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ConfigService } from '@nestjs/config';

import { PlatformType } from '@libs/core/domain/enums';
import { LocalSandboxService } from '@libs/sandbox/infrastructure/providers/local-sandbox.service';
import { buildAgentTools } from '@libs/code-review/infrastructure/agents/engine/agent-tools.factory';
import { UNINITIALIZED_SUBMODULE_MARKER } from '@libs/code-review/infrastructure/agents/engine/uninitialized-submodules';

const execFileAsync = promisify(execFile);

/**
 * End-to-end coverage for issue #1939 — the layer the mocked specs cannot give
 * us: real git, a real submodule, a real HTTP git server.
 *
 * The sandbox checkout is a shallow `git fetch` that never ran
 * `git submodule update`, so a path declared in `.gitmodules` existed as an
 * EMPTY directory. `grep`/`listDir`/`findFile` answered "nothing here" and the
 * finder published "X is undefined everywhere in the repo" as a critical
 * finding; the verifier re-ran the same empty search and kept it.
 *
 * Two things are proven here against a real checkout:
 *   1. a submodule on the repository's own host is actually populated;
 *   2. a submodule pointing at a DIFFERENT host is never fetched, and that
 *      host never receives the git token — `.gitmodules` ships inside the PR,
 *      so its URLs are authored by whoever opened it.
 */

/**
 * `git` exports GIT_DIR, GIT_INDEX_FILE and friends to any hook it runs, so
 * when this suite runs from the repo's own pre-push hook every `git` it spawns
 * would silently operate on kodus-ai instead of on its temp repositories.
 * GIT_EXEC_PATH is the one that has to survive — the CGI bridge needs it.
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

const git = (args: string[], env: Record<string, string> = {}) =>
    execFileAsync('git', args, { env: scrubbedGitEnv({ ...GIT_ENV, ...env }) });

describe('sandbox checkout of a repository with submodules', () => {
    jest.setTimeout(120_000);

    let server: Server;
    let port: number;
    let serverRoot: string;
    let scratch: string;
    let sandboxService: LocalSandboxService;
    /** Every Authorization header the foreign host was offered. */
    let foreignAuthSeen: string[];
    let foreignServer: Server;
    let foreignPort: number;

    /**
     * Repositories the token is NOT entitled to, modelling a GitHub App
     * installation set to "selected repositories" that leaves the submodule
     * repo out — the installation token is scoped to the installation, not to
     * a repo list we choose (github.service.ts, generateAndCacheNewToken).
     */
    let denied: Set<string>;

    /** Minimal git-http-backend CGI bridge — enough for a smart-protocol fetch. */
    const startGitServer = async (root: string) =>
        new Promise<{ server: Server; port: number }>((resolve) => {
            const srv = createServer((req, res) => {
                const [path, query = ''] = (req.url || '').split('?');

                if ([...denied].some((repo) => path.startsWith(`/${repo}`))) {
                    res.writeHead(403);
                    res.end('not in this installation');
                    return;
                }
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
                    const head = raw.subarray(0, sep).toString();
                    for (const line of head.split('\r\n')) {
                        const idx = line.indexOf(':');
                        if (idx > 0) {
                            res.setHeader(
                                line.slice(0, idx),
                                line.slice(idx + 1).trim(),
                            );
                        }
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
                    String(req.headers['authorization'] ?? ''),
                );
                res.writeHead(404);
                res.end('not a git server');
            });
            srv.listen(0, '127.0.0.1', () =>
                resolve({ server: srv, port: (srv.address() as any).port }),
            );
        });

    /** Publish `src` as a bare repo at `<serverRoot>/<name>.git`. */
    const publish = async (
        src: string,
        name: string,
        /**
         * false = a server that does NOT serve unadvertised objects, which is
         * git-http-backend's default and what many self-hosted installs run.
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
        return bare;
    };

    beforeAll(async () => {
        const { stdout } = await execFileAsync('git', ['--exec-path']);
        process.env.GIT_EXEC_PATH = stdout.trim();

        serverRoot = await mkdtemp(join(tmpdir(), 'kodus-sub-server-'));
        scratch = await mkdtemp(join(tmpdir(), 'kodus-sub-work-'));
        foreignAuthSeen = [];
        denied = new Set();

        ({ server, port } = await startGitServer(serverRoot));
        ({ server: foreignServer, port: foreignPort } =
            await startForeignHost());

        // --- the submodule repository ---
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

        // --- the superproject, on the SAME host ---
        const buildSuper = async (name: string, submoduleUrl: string) => {
            const dir = join(scratch, name);
            await git(['init', '-b', 'main', dir]);
            await writeFile(
                join(dir, '.gitmodules'),
                `[submodule "packages/commons"]\n\tpath = packages/commons\n\turl = ${submoduleUrl}\n`,
                'utf8',
            );
            await writeFile(
                join(dir, 'app.ts'),
                "import { coerceToDate } from './packages/commons/date';\n",
                'utf8',
            );
            await git(['-C', dir, 'add', '.gitmodules', 'app.ts']);
            // Write the gitlink directly — no network needed to author it.
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
        await buildSuper(
            'super-foreign',
            `http://127.0.0.1:${foreignPort}/commons.git`,
        );
        /**
         * A crafted `.gitmodules`: git's config parser accepts a variable on
         * the same line as the section header, so this declares TWO
         * submodules. A line scanner that only recognises a whole-line header
         * skips `[submodule "a"]` and attaches `path = packages/evil` to `b`,
         * which validates b's same-host url and then hands `packages/evil` to
         * `git submodule update` — fetched from the foreign host using a's
         * registered url. The same-host rule is bypassed end to end.
         */
        const buildSuperCrafted = async () => {
            const dir = join(scratch, 'super-crafted');
            await git(['init', '-b', 'main', dir]);
            await writeFile(
                join(dir, '.gitmodules'),
                `[submodule "b"]\n\tpath = packages/commons\n\turl = http://127.0.0.1:${port}/commons.git\n` +
                    `[submodule "a"] url = http://127.0.0.1:${foreignPort}/commons.git\n\tpath = packages/evil\n`,
                'utf8',
            );
            await git(['-C', dir, 'add', '.gitmodules']);
            for (const path of ['packages/commons', 'packages/evil']) {
                await git([
                    '-C',
                    dir,
                    'update-index',
                    '--add',
                    '--cacheinfo',
                    `160000,${subSha.trim()},${path}`,
                ]);
            }
            await git(['-C', dir, 'commit', '-m', 'super-crafted']);
            await publish(dir, 'super-crafted');
        };
        await buildSuperCrafted();

        /**
         * A pull request that ADDS a submodule: the base branch (`clean`) has
         * no `.gitmodules` at all, the head adds one pointing at a repository
         * on the same host. This is the fork-PR shape — same host, so the
         * host check allows it — and the token the fetch would use is not
         * scoped to the repository under review.
         */
        const buildSuperAdds = async () => {
            const dir = join(scratch, 'super-adds');
            await git(['init', '-b', 'clean', dir]);
            await writeFile(
                join(dir, 'app.ts'),
                'export const a = 1;\n',
                'utf8',
            );
            await git(['-C', dir, 'add', 'app.ts']);
            await git(['-C', dir, 'commit', '-m', 'base with no submodule']);
            await git(['-C', dir, 'checkout', '-q', '-b', 'main']);
            await writeFile(
                join(dir, '.gitmodules'),
                `[submodule "packages/commons"]\n\tpath = packages/commons\n\turl = http://127.0.0.1:${port}/commons.git\n`,
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
            await git(['-C', dir, 'commit', '-m', 'add the submodule']);
            await publish(dir, 'super-adds');
        };
        await buildSuperAdds();

        // The idiomatic form, and the one this fix stopped resolving itself:
        // origin is `<host>/super-relative.git`, so git resolves `../` to
        // `<host>/commons.git`.
        await buildSuper('super-relative', '../commons.git');
        // An over-deep chain: git turns this into the scp-like `.:…`, NOT into
        // an http url on the repo host the way WHATWG resolution would.
        await buildSuper(
            'super-escape',
            '../../../../../../evil.example/commons.git',
        );

        /** A superproject declaring two submodules at two paths. */
        const buildSuperTwo = async (
            name: string,
            second: { path: string; url: string; sha: string },
        ) => {
            const dir = join(scratch, name);
            await git(['init', '-b', 'main', dir]);
            await writeFile(
                join(dir, '.gitmodules'),
                `[submodule "commons-mod"]\n\tpath = packages/commons\n\turl = http://127.0.0.1:${port}/commons.git\n` +
                    `[submodule "second-mod"]\n\tpath = ${second.path}\n\turl = ${second.url}\n`,
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
                `160000,${second.sha},${second.path}`,
            ]);
            await git(['-C', dir, 'commit', '-m', name]);
            await publish(dir, name);
        };

        // A legitimate submodule NEXT TO one whose relative url git cannot
        // resolve — `git submodule init` is all-or-nothing.
        await buildSuperTwo('super-mixed', {
            path: 'packages/broken',
            url: '../../../../../../evil.example/x.git',
            sha: subSha.trim(),
        });
        // Two reachable submodules; the test denies one to model an
        // installation that covers `brain` but not `commons`.
        await buildSuperTwo('super-two', {
            path: 'packages/brain',
            url: `http://127.0.0.1:${port}/brain.git`,
            sha: sub2Sha.trim(),
        });

        // A submodule pinned to a commit that is NOT the branch tip, on a
        // server that does not serve unadvertised objects — the ordinary state
        // of a pinned submodule. This provider's recovery differs from E2B's:
        // it removes the leftover shallow gitdir with fs.rm, not a shell
        // `rm -rf`, so it needs its own end-to-end proof.
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

        sandboxService = new LocalSandboxService({
            get: jest.fn(),
        } as unknown as ConfigService);
    });

    afterAll(async () => {
        await new Promise<void>((r) => server?.close(() => r()));
        await new Promise<void>((r) => foreignServer?.close(() => r()));
        await rm(serverRoot, { recursive: true, force: true });
        await rm(scratch, { recursive: true, force: true });
    });

    beforeEach(() => {
        denied = new Set();
        foreignAuthSeen = [];
    });

    /**
     * `baseBranch` is the same branch here, which models the MERGED case: the
     * `.gitmodules` entry the pull request carries is byte-identical to the
     * one on the base, so it is fetched. Only that case fetches — see
     * `baseDeclaredDumpArgs`. A pull request that ADDS a submodule has its
     * own test at the bottom of this file.
     */
    const checkout = (repo: string, baseBranch = 'main') =>
        sandboxService.createSandboxWithRepo({
            cloneUrl: `http://127.0.0.1:${port}/${repo}.git`,
            authToken: 'test-token',
            branch: 'main',
            baseBranch,
            platform: PlatformType.GITHUB,
        } as any);

    it('populates a submodule hosted on the repository’s own server', async () => {
        const sandbox = await checkout('super');
        try {
            // The real proof: this file only exists if the submodule was
            // actually fetched. Before the fix the directory was empty.
            const read = await sandbox.run('cat packages/commons/date.ts');
            expect(read.exitCode).toBe(0);
            expect(read.stdout).toContain('coerceToDate');

            // And the tools the agent uses now find it.
            const grep = await sandbox.remoteCommands.grep(
                'coerceToDate',
                'packages/commons',
            );
            expect(grep).toContain('date.ts');
        } finally {
            await sandbox.cleanup?.();
        }
    });

    it('populates a submodule declared with a RELATIVE url, the idiomatic form', async () => {
        const sandbox = await checkout('super-relative');
        try {
            // `url = ../commons.git`. Resolving this in TypeScript instead of
            // asking git gives a DIFFERENT url — the whole reason the provider
            // runs `git submodule init` first and validates what git wrote.
            const read = await sandbox.run('cat packages/commons/date.ts');
            expect(read.exitCode).toBe(0);
            expect(read.stdout).toContain('coerceToDate');
        } finally {
            await sandbox.cleanup?.();
        }
    });

    it('rejects an over-deep relative url, which git resolves off-host', async () => {
        const sandbox = await checkout('super-escape');
        try {
            // Nothing fetched, and the checkout still succeeded.
            expect(
                await readdir(join(sandbox.repoDir, 'packages', 'commons')),
            ).toEqual([]);
            // The refusal outlives the call: the url git registered for it is
            // gone from the checkout's config, so a later `git submodule
            // update` in this sandbox cannot use it either.
            const cfg = await sandbox.run(
                'git config --get submodule.packages/commons.url',
            );
            expect(cfg.stdout.trim()).toBe('');
        } finally {
            await sandbox.cleanup?.();
        }
    });

    it('degrades to an unpopulated submodule when the token does not cover it', async () => {
        // The GitHub App installation includes the superproject but not the
        // submodule repository — the installation token is scoped to the
        // installation, so this is not something the fetch can work around.
        denied = new Set(['commons.git']);
        const sandbox = await checkout('super');
        try {
            // The review still happens: the superproject is checked out.
            const app = await sandbox.run('cat app.ts');
            expect(app.exitCode).toBe(0);

            // And the submodule is simply empty — which the uninitialized
            // marker then explains to the agent instead of letting it read the
            // emptiness as proof.
            expect(
                await readdir(join(sandbox.repoDir, 'packages', 'commons')),
            ).toEqual([]);
        } finally {
            await sandbox.cleanup?.();
        }
    });

    it('one broken submodule does not stop the legitimate one next to it', async () => {
        // `git submodule init` aborts wholesale on an unresolvable url
        // (measured: `fatal: cannot strip one component off url '.'`), so
        // without the per-path retry this repository fetched NOTHING.
        const sandbox = await checkout('super-mixed');
        try {
            expect(
                await readdir(join(sandbox.repoDir, 'packages', 'commons')),
            ).toContain('date.ts');
            expect(
                await readdir(join(sandbox.repoDir, 'packages', 'broken')),
            ).toEqual([]);
        } finally {
            await sandbox.cleanup?.();
        }
    });

    it('an inaccessible submodule does not block an accessible one', async () => {
        // `git submodule update` aborts at the first submodule it cannot
        // clone, so a token covering `brain` but not `commons` would otherwise
        // fetch neither. This provider runs on the customer's own machine, so
        // it needs the guarantee at least as much as E2B does.
        denied = new Set(['commons.git']);
        const sandbox = await checkout('super-two');
        try {
            expect(
                await readdir(join(sandbox.repoDir, 'packages', 'brain')),
            ).toContain('brain.ts');
            expect(
                await readdir(join(sandbox.repoDir, 'packages', 'commons')),
            ).toEqual([]);
        } finally {
            await sandbox.cleanup?.();
        }
    });

    it('populates a submodule pinned to a commit the server will not advertise', async () => {
        // `--depth=1` only gets the advertised tips: `error: Server does not
        // allow request for unadvertised object <sha>`, directory left EMPTY.
        // Retrying without --depth=1 in place fails identically — the failed
        // attempt leaves a SHALLOW gitdir behind — so the recovery clears it
        // first. On this provider that removal is fs.rm, not a shell rm -rf.
        const sandbox = await checkout('super-pinned');
        try {
            const read = await sandbox.run('cat packages/pinned/pinned.ts');
            expect(read.exitCode).toBe(0);
            // The PINNED content, not the tip.
            expect(read.stdout).toContain('export const p = 1;');
        } finally {
            await sandbox.cleanup?.();
        }
    });

    it('the agent tools see the fetched submodule, and say nothing about it', async () => {
        // Step 3 and step 2 composed: once the content is really there, the
        // tools find it and the "never fetched" marker must stay quiet.
        const sandbox = await checkout('super');
        try {
            const tools = buildAgentTools(sandbox.remoteCommands);
            const grep = await tools.grep.execute({
                pattern: 'coerceToDate',
                path: 'packages/commons',
            });
            expect(grep).toContain('date.ts');
            expect(grep).not.toContain(UNINITIALIZED_SUBMODULE_MARKER);

            const list = await tools.listDir.execute({
                path: 'packages/commons',
            });
            expect(list).toContain('date.ts');
            expect(list).not.toContain(UNINITIALIZED_SUBMODULE_MARKER);
        } finally {
            await sandbox.cleanup?.();
        }
    });

    it('the agent tools explain the submodule the token could not reach', async () => {
        // The other half of the same contract: when the fetch genuinely could
        // not happen, the emptiness must stop reading as proof of absence —
        // this is the exact search that produced the critical false positive.
        denied = new Set(['commons.git']);
        const sandbox = await checkout('super');
        try {
            const tools = buildAgentTools(sandbox.remoteCommands);
            const grep = await tools.grep.execute({
                pattern: 'coerceToDate',
                path: 'packages/commons',
            });
            expect(grep).toContain(UNINITIALIZED_SUBMODULE_MARKER);
            expect(grep).toMatch(/NOT evidence/i);
        } finally {
            await sandbox.cleanup?.();
        }
    });

    it('never fetches a submodule on a different host, and never offers it the token', async () => {
        foreignAuthSeen = [];
        const sandbox = await checkout('super-foreign');
        try {
            // The checkout itself still succeeds — a rejected submodule must
            // not fail the review.
            const app = await sandbox.run('cat app.ts');
            expect(app.exitCode).toBe(0);

            // The submodule directory is present and empty, which is what the
            // uninitialized-submodule marker then explains to the agent.
            // `repoDir` is asserted first so a future rename cannot turn this
            // into a test that passes by failing to look.
            expect(sandbox.repoDir).toBeTruthy();
            const listing = await readdir(
                join(sandbox.repoDir, 'packages', 'commons'),
            );
            expect(listing).toEqual([]);

            // The point of the same-host rule: nothing was ever sent there.
            expect(foreignAuthSeen).toEqual([]);
        } finally {
            await sandbox.cleanup?.();
        }
    });

    it('does NOT fetch a submodule the pull request adds, even on the repo host', async () => {
        // Same host is not the same as authorized: the token is not scoped to
        // the repository under review, so a pull request that ADDS a
        // submodule could point it at any repository that token can read.
        // Only a declaration already on the base branch is fetched.
        const sandbox = await checkout('super-adds', 'clean');
        try {
            expect(sandbox.repoDir).toBeTruthy();
            const listing = await readdir(
                join(sandbox.repoDir, 'packages', 'commons'),
            );
            expect(listing).toEqual([]);

            // And the agent is told the directory is unexplained, not empty.
            const tools = buildAgentTools(sandbox.remoteCommands);
            const grep = await tools.grep.execute({
                pattern: 'coerceToDate',
                path: 'packages/commons',
            });
            expect(grep).toContain(UNINITIALIZED_SUBMODULE_MARKER);
        } finally {
            await sandbox.cleanup?.();
        }
    });

    it('fetches the same submodule once it IS on the base branch', async () => {
        // The other direction: identical declaration on both sides.
        const sandbox = await checkout('super-adds', 'main');
        try {
            const read = await sandbox.run('cat packages/commons/date.ts');
            expect(read.exitCode).toBe(0);
            expect(read.stdout).toContain('coerceToDate');
        } finally {
            await sandbox.cleanup?.();
        }
    });

    it('a crafted .gitmodules cannot smuggle a foreign-host path past the rule', async () => {
        // Regression for the bypass described at `buildSuperCrafted`. The
        // declaration is read through git's own config parser, so both
        // sections are seen, `packages/evil` is judged on ITS url, and the
        // legitimate sibling is still fetched.
        foreignAuthSeen = [];
        const sandbox = await checkout('super-crafted');
        try {
            expect(sandbox.repoDir).toBeTruthy();

            // What the bypass produced: `packages/evil` populated from the
            // foreign host. Asserted FIRST so a regression reports the
            // security failure, not a side effect of it.
            const listing = await readdir(
                join(sandbox.repoDir, 'packages', 'evil'),
            );
            expect(listing).toEqual([]);
            // Not one request reached the foreign host, with or without a
            // token.
            expect(foreignAuthSeen).toEqual([]);

            // The legitimate sibling is still fetched.
            const good = await sandbox.run('cat packages/commons/date.ts');
            expect(good.exitCode).toBe(0);
            expect(good.stdout).toContain('coerceToDate');

            // And the refused url does not survive in the checkout config,
            // so a later `submodule update` in this sandbox cannot use it.
            const config = await sandbox.run(
                'git config --get-regexp submodule',
            );
            expect(config.stdout).not.toContain(String(foreignPort));
        } finally {
            await sandbox.cleanup?.();
        }
    });
});
