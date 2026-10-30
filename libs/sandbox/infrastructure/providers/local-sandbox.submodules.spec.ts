const execFileMock = jest.fn();

jest.mock('child_process', () => ({
    ...jest.requireActual('child_process'),
    execFile: (...args: any[]) => execFileMock(...args),
}));

import { execFileSync } from 'child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';

import { LocalSandboxService } from './local-sandbox.service';

/**
 * #1939 — the local provider's half of the submodule fetch.
 *
 * The design asked for the step-3 guarantees on BOTH providers, and this one
 * matters at least as much: it runs directly on the self-hosted customer's own
 * machine, with no proxy in between. The E2B counterpart lives in
 * `e2b-sandbox.submodules.spec.ts`; the real-git end-to-end in
 * `test/integration/sandbox/submodule-checkout.integration.spec.ts`.
 */

const REPO = 'https://github.com/acme/app.git';
const AUTH = 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46U0VDUkVU';

const GITMODULES_SAME_HOST =
    '[submodule "commons-mod"]\n\tpath = packages/commons\n\turl = https://github.com/acme/commons.git\n';
const GITMODULES_FOREIGN_HOST =
    '[submodule "commons-mod"]\n\tpath = packages/commons\n\turl = https://evil.example/acme/commons.git\n';

/**
 * The DECLARED dump is answered by REAL git, against the real `.gitmodules`
 * each test writes. The provider reads the declaration through git's own
 * config parser rather than scanning the file, so a hand-written fixture here
 * would test the fixture instead of that parser.
 *
 * `git config --get-regexp` exits 1 when nothing matched, which is normal.
 */
const realDeclaredDump = (args: string[]) => {
    // The base dump reads a blob from a ref this fake repo has no commit for,
    // so replay it against the same `.gitmodules` on disk: the merged case,
    // which is the only one that fetches. Divergence is covered in
    // submodule-fetch.spec.ts.
    const replay = args.map((a) =>
        a === '--blob' ? '-f' : /:\.gitmodules$/.test(a) ? '.gitmodules' : a,
    );
    try {
        return execFileSync('git', replay, { encoding: 'utf8' });
    } catch {
        return '';
    }
};

/** Is this the `-f .gitmodules` dump, or the resolved `.git/config` one? */
const isDeclaredDump = (args: string[]) =>
    args.includes('-f') && args.includes('.gitmodules');

/** The BASE branch dump, read from the blob. */
const isBaseDump = (args: string[]) => args.includes('--blob');

/** Is this the cheap "is the base ref here?" probe? */
const isRevParse = (args: string[]) => args.includes('rev-parse');

/** `promisify(execFile)` calls it with (file, args, opts, callback). */
function answerWith(resolved: string) {
    execFileMock.mockImplementation(
        (_file: string, args: string[], _opts: any, cb: any) => {
            const done = typeof _opts === 'function' ? _opts : cb;
            if (isRevParse(args)) {
                done(null, { stdout: 'abc123', stderr: '' });
                return;
            }
            if (args.includes('--get-regexp')) {
                done(null, {
                    stdout:
                        isDeclaredDump(args) || isBaseDump(args)
                            ? realDeclaredDump(args)
                            : resolved,
                    stderr: '',
                });
                return;
            }
            done(null, { stdout: '', stderr: '' });
        },
    );
}

const gitCalls = () =>
    execFileMock.mock.calls.map(([, args]) => args as string[]);
const updateCalls = () =>
    gitCalls().filter((a) => a.includes('submodule') && a.includes('update'));

describe('LocalSandboxService.fetchSubmodules', () => {
    let repoDir: string;
    let service: LocalSandboxService;

    const BASE_REF = 'refs/remotes/origin/main';
    const run = (gitmodules: string, authHeader = AUTH) =>
        (service as any).fetchSubmodules(
            repoDir,
            REPO,
            authHeader,
            {},
            BASE_REF,
        );

    beforeEach(async () => {
        execFileMock.mockReset();
        repoDir = await mkdtemp(join(tmpdir(), 'kodus-local-sub-'));
        service = new LocalSandboxService({
            get: jest.fn(),
        } as unknown as ConfigService);
    });

    afterEach(async () => {
        await rm(repoDir, { recursive: true, force: true });
    });

    const withGitmodules = async (content: string) =>
        writeFile(join(repoDir, '.gitmodules'), content, 'utf8');

    it('does nothing at all when the repo has no .gitmodules', async () => {
        answerWith('');
        await run(GITMODULES_SAME_HOST);
        expect(execFileMock).not.toHaveBeenCalled();
    });

    it('fetches a same-host submodule, one command for the declared path', async () => {
        await withGitmodules(GITMODULES_SAME_HOST);
        answerWith(
            'submodule.commons-mod.url https://github.com/acme/commons.git\n',
        );
        await run(GITMODULES_SAME_HOST);
        expect(updateCalls()).toEqual([
            [
                '-C',
                repoDir,
                'submodule',
                'update',
                '--depth=1',
                '--',
                'packages/commons',
            ],
        ]);
    });

    it('carries the token as a SCOPED config env, never as an argument', async () => {
        await withGitmodules(GITMODULES_SAME_HOST);
        answerWith(
            'submodule.commons-mod.url https://github.com/acme/commons.git\n',
        );
        await run(GITMODULES_SAME_HOST);
        const [, , opts] = execFileMock.mock.calls.at(-1)!;
        expect(opts.env.GIT_CONFIG_KEY_0).toBe(
            'http.https://github.com/.extraHeader',
        );
        expect(opts.env.GIT_CONFIG_KEY_0).not.toBe('http.extraHeader');
        expect(opts.env.GIT_CONFIG_VALUE_0).toBe(AUTH);
        for (const args of gitCalls()) {
            expect(args.join(' ')).not.toContain(AUTH);
        }
    });

    it('bounds the fetch with a timeout so a big repo cannot hang the review', async () => {
        await withGitmodules(GITMODULES_SAME_HOST);
        answerWith(
            'submodule.commons-mod.url https://github.com/acme/commons.git\n',
        );
        await run(GITMODULES_SAME_HOST);
        const [, , opts] = execFileMock.mock.calls.at(-1)!;
        expect(opts.timeout).toBeGreaterThan(0);
    });

    it('never fetches a foreign-host submodule, and never names that host', async () => {
        await withGitmodules(GITMODULES_FOREIGN_HOST);
        answerWith(
            'submodule.commons-mod.url https://evil.example/acme/commons.git\n',
        );
        await run(GITMODULES_FOREIGN_HOST);
        expect(updateCalls()).toEqual([]);
        for (const args of gitCalls()) {
            expect(args.join(' ')).not.toContain('evil.example');
        }
    });

    it('removes the rejected url from the checkout config', async () => {
        await withGitmodules(GITMODULES_FOREIGN_HOST);
        answerWith(
            'submodule.commons-mod.url https://evil.example/acme/commons.git\n',
        );
        await run(GITMODULES_FOREIGN_HOST);
        expect(
            gitCalls().some(
                (a) =>
                    a.includes('--remove-section') &&
                    a.includes('submodule.commons-mod'),
            ),
        ).toBe(true);
    });

    it('emits no auth config at all for an anonymous clone', async () => {
        await withGitmodules(GITMODULES_SAME_HOST);
        answerWith(
            'submodule.commons-mod.url https://github.com/acme/commons.git\n',
        );
        await run(GITMODULES_SAME_HOST, '');
        const [, , opts] = execFileMock.mock.calls.at(-1)!;
        expect(opts.env.GIT_CONFIG_COUNT).toBeUndefined();
        expect(opts.env.GIT_CONFIG_VALUE_0).toBeUndefined();
    });

    it('supplies remote.origin.url — this provider never adds an origin remote', async () => {
        await withGitmodules(GITMODULES_SAME_HOST);
        answerWith(
            'submodule.commons-mod.url https://github.com/acme/commons.git\n',
        );
        await run(GITMODULES_SAME_HOST);
        expect(
            gitCalls().some((a) => a.includes(`remote.origin.url=${REPO}`)),
        ).toBe(true);
    });

    it('shares one time budget across ALL submodules, not one each', async () => {
        // Going per path must not hand each submodule a fresh full allowance:
        // ten submodules would hold the review for ten times as long.
        const THREE =
            '[submodule "a"]\n\tpath = pkg/a\n\turl = https://github.com/acme/a.git\n' +
            '[submodule "b"]\n\tpath = pkg/b\n\turl = https://github.com/acme/b.git\n' +
            '[submodule "c"]\n\tpath = pkg/c\n\turl = https://github.com/acme/c.git\n';
        await withGitmodules(THREE);
        execFileMock.mockImplementation(
            (_f: string, args: string[], opts: any, cb: any) => {
                const done = typeof opts === 'function' ? opts : cb;
                if (isRevParse(args)) {
                    done(null, { stdout: 'abc123', stderr: '' });
                    return;
                }
                if (args.includes('--get-regexp')) {
                    done(null, {
                        stdout:
                            isDeclaredDump(args) || isBaseDump(args)
                                ? realDeclaredDump(args)
                                : 'submodule.a.url https://github.com/acme/a.git\n' +
                                  'submodule.b.url https://github.com/acme/b.git\n' +
                                  'submodule.c.url https://github.com/acme/c.git\n',
                        stderr: '',
                    });
                    return;
                }
                // Each update takes measurable time so elapsed is never 0ms.
                if (args.includes('update')) {
                    setTimeout(
                        () => done(null, { stdout: '', stderr: '' }),
                        20,
                    );
                    return;
                }
                done(null, { stdout: '', stderr: '' });
            },
        );
        await run(THREE);
        const budgets = execFileMock.mock.calls
            .filter(([, a]) => (a as string[]).includes('update'))
            .map(([, , o]) => (o as any).timeout as number);
        expect(budgets).toHaveLength(3);
        expect(budgets[1]).toBeLessThan(budgets[0]);
        expect(budgets[2]).toBeLessThan(budgets[1]);
        for (const b of budgets) expect(b).toBeLessThanOrEqual(120_000);
    });

    it('recovers a submodule whose shallow fetch failed, clearing the stale gitdir', async () => {
        // The shallow attempt leaves a SHALLOW gitdir behind; retrying in
        // place reuses it and fails identically. The recovery must deinit,
        // drop `.git/modules/<name>`, re-init and fetch full.
        await withGitmodules(GITMODULES_SAME_HOST);
        const seen: string[][] = [];
        execFileMock.mockImplementation(
            (_f: string, args: string[], opts: any, cb: any) => {
                const done = typeof opts === 'function' ? opts : cb;
                seen.push(args);
                if (isRevParse(args)) {
                    done(null, { stdout: 'abc123', stderr: '' });
                    return;
                }
                if (args.includes('--get-regexp')) {
                    done(null, {
                        stdout:
                            isDeclaredDump(args) || isBaseDump(args)
                                ? realDeclaredDump(args)
                                : 'submodule.commons-mod.url https://github.com/acme/commons.git\n',
                        stderr: '',
                    });
                    return;
                }
                if (args.includes('update') && args.includes('--depth=1')) {
                    done(
                        new Error(
                            'Server does not allow request for unadvertised object',
                        ),
                    );
                    return;
                }
                done(null, { stdout: '', stderr: '' });
            },
        );
        await run(GITMODULES_SAME_HOST);
        const flat = seen.map((a) => a.join(' '));
        expect(flat.some((c) => c.includes('deinit -f'))).toBe(true);
        expect(
            flat.some(
                (c) =>
                    c.includes('submodule update') && !c.includes('--depth=1'),
            ),
        ).toBe(true);
    });

    it('never breaks the review when the fetch fails', async () => {
        await withGitmodules(GITMODULES_SAME_HOST);
        execFileMock.mockImplementation(
            (_f: string, args: string[], opts: any, cb: any) => {
                const done = typeof opts === 'function' ? opts : cb;
                if (isRevParse(args)) {
                    done(null, { stdout: 'abc123', stderr: '' });
                    return;
                }
                if (args.includes('--get-regexp')) {
                    done(null, {
                        stdout:
                            isDeclaredDump(args) || isBaseDump(args)
                                ? realDeclaredDump(args)
                                : 'submodule.commons-mod.url https://github.com/acme/commons.git\n',
                        stderr: '',
                    });
                    return;
                }
                if (args.includes('update')) {
                    done(new Error('fatal: could not read Username'));
                    return;
                }
                done(null, { stdout: '', stderr: '' });
            },
        );
        await expect(run(GITMODULES_SAME_HOST)).resolves.toBeUndefined();
    });
});
