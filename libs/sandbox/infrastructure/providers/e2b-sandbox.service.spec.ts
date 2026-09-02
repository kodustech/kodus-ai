import { PlatformType } from '@libs/core/domain/enums';

// The real `e2b` SDK does not resolve to a usable class under jest (its ESM
// export leaves CommandExitError undefined), which breaks the `instanceof`
// check in runCmd. Provide a real class shared by BOTH the source-under-test
// and this spec so the normalization branch can be exercised.
jest.mock('e2b', () => {
    class CommandExitError extends Error {
        stdout: string;
        stderr: string;
        exitCode: number;
        constructor(o: {
            stdout: string;
            stderr: string;
            exitCode: number;
            error?: string;
        }) {
            super(o.error ?? 'command exited non-zero');
            this.stdout = o.stdout;
            this.stderr = o.stderr;
            this.exitCode = o.exitCode;
        }
    }
    return { CommandExitError, Sandbox: class {} };
});

import { CommandExitError } from 'e2b';

import {
    E2BSandboxService,
    buildE2BRemoteCommands,
} from './e2b-sandbox.service';

const REPO_DIR = '/home/user/repo';

/**
 * Mutation-killing tests for the deterministic logic in e2b-sandbox.service:
 *   - buildAuthHeader   (private git-over-HTTPS Authorization builder)
 *   - buildRemoteCommands / buildE2BRemoteCommands (read-only sandbox tools)
 *
 * These assert exact command strings, exact return literals, branch boundaries,
 * and error/fallback behaviour so a plausible regression makes a test fail.
 */

// ---------------------------------------------------------------------------
// buildAuthHeader
// ---------------------------------------------------------------------------
describe('E2BSandboxService.buildAuthHeader', () => {
    const service = new E2BSandboxService({} as any);
    const build = (platform: PlatformType, token: string, username?: string) =>
        (service as any).buildAuthHeader(platform, token, username) as string;

    // Decode the base64 payload back to the `user:secret` pair.
    const decode = (header: string) => {
        expect(header.startsWith('Authorization: Basic ')).toBe(true);
        return Buffer.from(
            header.replace('Authorization: Basic ', ''),
            'base64',
        ).toString('utf8');
    };

    it('emits the exact header for GitHub (x-access-token user)', () => {
        const header = build(PlatformType.GITHUB, 'ghtok');
        expect(header).toBe(
            `Authorization: Basic ${Buffer.from('x-access-token:ghtok').toString('base64')}`,
        );
        expect(decode(header)).toBe('x-access-token:ghtok');
    });

    it('uses oauth2 for GitLab', () => {
        expect(decode(build(PlatformType.GITLAB, 'gltok'))).toBe(
            'oauth2:gltok',
        );
    });

    it('uses oauth2 for Azure Repos', () => {
        expect(decode(build(PlatformType.AZURE_REPOS, 'aztok'))).toBe(
            'oauth2:aztok',
        );
    });

    it('falls back to x-access-token for any unlisted platform (default branch)', () => {
        // FORGEJO hits the default case — proves the default is x-access-token,
        // not oauth2 and not a throw.
        expect(decode(build(PlatformType.FORGEJO, 'fjtok'))).toBe(
            'x-access-token:fjtok',
        );
        expect(decode(build(PlatformType.INTERNAL, 'intok'))).toBe(
            'x-access-token:intok',
        );
    });

    describe('Bitbucket', () => {
        it('uses the literal x-bitbucket-api-token-auth for ATATT tokens, ignoring the username', () => {
            expect(
                decode(
                    build(PlatformType.BITBUCKET, 'ATATTsecret', 'ignored@me'),
                ),
            ).toBe('x-bitbucket-api-token-auth:ATATTsecret');
        });

        it('does not throw for an ATATT token even without a username', () => {
            expect(decode(build(PlatformType.BITBUCKET, 'ATATTsecret'))).toBe(
                'x-bitbucket-api-token-auth:ATATTsecret',
            );
        });

        it('uses the account username for classic app passwords (non-ATATT)', () => {
            expect(
                decode(build(PlatformType.BITBUCKET, 'apppass', 'alice')),
            ).toBe('alice:apppass');
        });

        it('treats a near-miss prefix (ATAT, one T short) as a classic token requiring a username', () => {
            // Boundary for startsWith('ATATT'): 'ATAT' must NOT be the API-token path.
            expect(
                decode(build(PlatformType.BITBUCKET, 'ATATshort', 'bob')),
            ).toBe('bob:ATATshort');
        });

        it('throws when a non-ATATT token has no username', () => {
            expect(() => build(PlatformType.BITBUCKET, 'apppass')).toThrow(
                'Bitbucket authentication requires a username (app password) or an Atlassian API token, but neither was provided.',
            );
        });

        it('throws for a near-miss ATAT prefix with no username', () => {
            expect(() => build(PlatformType.BITBUCKET, 'ATATshort')).toThrow(
                /requires a username/,
            );
        });
    });
});

// ---------------------------------------------------------------------------
// buildE2BRemoteCommands (also reached via buildRemoteCommands)
// ---------------------------------------------------------------------------
describe('buildE2BRemoteCommands', () => {
    // A fake E2B sandbox whose commands.run we drive per-test.
    const makeSandbox = (run: jest.Mock) => ({ commands: { run } }) as any;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    const exitError = (
        stdout: string,
        stderr: string,
        exitCode: number,
    ): CommandExitError =>
        new CommandExitError({
            stdout,
            stderr,
            exitCode,
            error: '',
        } as any);

    describe('runCmd normalization', () => {
        it('returns the CommandExitError fields as a plain result instead of throwing (via exec)', async () => {
            const run = jest
                .fn()
                .mockRejectedValue(exitError('out', 'boom', 3));
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            const res = await rc.exec('do-thing');
            expect(res).toEqual({ stdout: 'out', stderr: 'boom', exitCode: 3 });
        });

        it('re-throws a non-CommandExitError error (via exec)', async () => {
            const run = jest.fn().mockRejectedValue(new Error('network down'));
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            await expect(rc.exec('do-thing')).rejects.toThrow('network down');
        });
    });

    describe('resolveRepoPath guards (via read)', () => {
        it('rejects absolute paths', async () => {
            const rc = buildE2BRemoteCommands(makeSandbox(jest.fn()));
            await expect(rc.read('/etc/passwd', 0, 0)).rejects.toThrow(
                'Absolute paths are not allowed',
            );
        });

        it('rejects ".." traversal', async () => {
            const rc = buildE2BRemoteCommands(makeSandbox(jest.fn()));
            await expect(rc.read('../secret', 0, 0)).rejects.toThrow(
                'Path traversal using ".." is not allowed',
            );
        });

        it('accepts a plain relative path (no throw)', async () => {
            const run = jest
                .fn()
                .mockResolvedValue({ stdout: 'x', stderr: '', exitCode: 0 });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            await expect(rc.read('src/a.ts', 0, 0)).resolves.toBe('x');
        });
    });

    describe('grep', () => {
        it('builds the rg command against REPO_DIR and returns stdout when present', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: 'a.ts:1:hit',
                stderr: '',
                exitCode: 0,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            const out = await rc.grep('needle', 'src');
            expect(out).toBe('a.ts:1:hit');
            expect(run).toHaveBeenCalledWith(
                `cd ${REPO_DIR} && rg --no-heading -n 'needle' 'src'`,
                { timeoutMs: 30_000 },
            );
        });

        it('appends the --glob argument when a glob is given', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: 'x',
                stderr: '',
                exitCode: 0,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            await rc.grep('needle', 'src', '*.ts');
            expect(run).toHaveBeenCalledWith(
                `cd ${REPO_DIR} && rg --no-heading -n 'needle' 'src' --glob '*.ts'`,
                { timeoutMs: 30_000 },
            );
        });

        it('escapes single quotes in pattern, path and glob', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: 'x',
                stderr: '',
                exitCode: 0,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            await rc.grep("a'b", "d'ir", "*'.ts");
            expect(run).toHaveBeenCalledWith(
                `cd ${REPO_DIR} && rg --no-heading -n 'a'\\''b' 'd'\\''ir' --glob '*'\\''.ts'`,
                { timeoutMs: 30_000 },
            );
        });

        it("returns 'No matches found.' on rg exit 1 with empty stdout", async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: '',
                stderr: '',
                exitCode: 1,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            expect(await rc.grep('x', 'src')).toBe('No matches found.');
        });

        it("returns 'No matches found.' at the boundary exit 1 even with stderr (>=2 is false)", async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: '',
                stderr: 'some warning',
                exitCode: 1,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            expect(await rc.grep('x', 'src')).toBe('No matches found.');
        });

        it('returns the error string at the boundary exit 2 with stderr and empty stdout', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: '',
                stderr: 'regex parse error',
                exitCode: 2,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            expect(await rc.grep('x', 'src')).toBe('Error: regex parse error');
        });

        it("returns 'No matches found.' when exit >=2 but stderr is empty", async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: '',
                stderr: '',
                exitCode: 2,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            expect(await rc.grep('x', 'src')).toBe('No matches found.');
        });

        it('returns stdout even when exitCode >=2 and stderr is set (stdout wins)', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: 'partial hit',
                stderr: 'noise',
                exitCode: 2,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            expect(await rc.grep('x', 'src')).toBe('partial hit');
        });
    });

    describe('read', () => {
        it('uses cat when start and end are both 0 (whole file)', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: 'file body',
                stderr: '',
                exitCode: 0,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            const out = await rc.read('src/a.ts', 0, 0);
            expect(out).toBe('file body');
            expect(run).toHaveBeenCalledWith(`cat '${REPO_DIR}/src/a.ts'`, {
                timeoutMs: 10_000,
            });
        });

        it('uses sed with the exact line range for a normal window', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: 'lines',
                stderr: '',
                exitCode: 0,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            await rc.read('src/a.ts', 2, 10);
            expect(run).toHaveBeenCalledWith(
                `sed -n '2,10p' '${REPO_DIR}/src/a.ts'`,
                { timeoutMs: 10_000 },
            );
        });

        it('clamps start below 1 up to 1 (start=0 with non-zero end)', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: 'lines',
                stderr: '',
                exitCode: 0,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            await rc.read('src/a.ts', 0, 5);
            expect(run).toHaveBeenCalledWith(
                `sed -n '1,5p' '${REPO_DIR}/src/a.ts'`,
                { timeoutMs: 10_000 },
            );
        });

        it('keeps start=1 unchanged (boundary of the clamp)', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: 'lines',
                stderr: '',
                exitCode: 0,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            await rc.read('src/a.ts', 1, 5);
            expect(run).toHaveBeenCalledWith(
                `sed -n '1,5p' '${REPO_DIR}/src/a.ts'`,
                { timeoutMs: 10_000 },
            );
        });

        it('clamps a negative start up to 1', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: 'lines',
                stderr: '',
                exitCode: 0,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            await rc.read('src/a.ts', -4, 3);
            expect(run).toHaveBeenCalledWith(
                `sed -n '1,3p' '${REPO_DIR}/src/a.ts'`,
                { timeoutMs: 10_000 },
            );
        });

        it('escapes single quotes in the resolved path', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: 'x',
                stderr: '',
                exitCode: 0,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            await rc.read("src/o'brien.ts", 0, 0);
            expect(run).toHaveBeenCalledWith(
                `cat '${REPO_DIR}/src/o'\\''brien.ts'`,
                { timeoutMs: 10_000 },
            );
        });

        it('throws the trimmed stderr when stdout is empty and stderr is set', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: '',
                stderr: '  sed: No such file or directory\n',
                exitCode: 2,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            await expect(rc.read('missing.ts', 0, 0)).rejects.toThrow(
                'sed: No such file or directory',
            );
        });

        it('returns empty string (no throw) when stdout and stderr are both empty', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: '',
                stderr: '',
                exitCode: 0,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            await expect(rc.read('empty.ts', 0, 0)).resolves.toBe('');
        });

        it('warns via the logger on an empty read, with the untrusted path in the message', async () => {
            const warn = jest.fn();
            const run = jest.fn().mockResolvedValue({
                stdout: '',
                stderr: '',
                exitCode: 0,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run), {
                logger: { warn } as any,
                logContext: 'TestCtx',
                logMetadata: { prKey: 'PR-1' },
            });
            await rc.read('empty.ts', 0, 0);
            expect(warn).toHaveBeenCalledTimes(1);
            const arg = warn.mock.calls[0][0];
            expect(arg.context).toBe('TestCtx');
            expect(arg.metadata).toMatchObject({
                prKey: 'PR-1',
                path: 'empty.ts',
                exitCode: 0,
            });
        });

        it('does NOT warn when stdout is non-empty', async () => {
            const warn = jest.fn();
            const run = jest.fn().mockResolvedValue({
                stdout: 'has content',
                stderr: '',
                exitCode: 0,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run), {
                logger: { warn } as any,
            });
            await rc.read('a.ts', 0, 0);
            expect(warn).not.toHaveBeenCalled();
        });
    });

    describe('listDir', () => {
        it('builds the find command with the exact maxdepth and returns raw stdout', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: '/home/user/repo/a.ts\n/home/user/repo/b.ts',
                stderr: '',
                exitCode: 0,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            const out = await rc.listDir('src', 3);
            expect(out).toBe('/home/user/repo/a.ts\n/home/user/repo/b.ts');
            expect(run).toHaveBeenCalledWith(
                `find '${REPO_DIR}/src' -maxdepth 3 -type f`,
                { timeoutMs: 30_000 },
            );
        });

        it('returns stdout untouched even when it is empty', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: '',
                stderr: 'find: permission denied',
                exitCode: 1,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            expect(await rc.listDir('src', 1)).toBe('');
        });
    });

    describe('exec', () => {
        it('prefixes the command with cd REPO_DIR and returns separated streams', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: 'ok',
                stderr: 'warn',
                exitCode: 0,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            const res = await rc.exec('git status');
            expect(res).toEqual({ stdout: 'ok', stderr: 'warn', exitCode: 0 });
            expect(run).toHaveBeenCalledWith(`cd ${REPO_DIR} && git status`, {
                timeoutMs: 30_000,
            });
        });

        it('defaults a falsy stderr to an empty string', async () => {
            const run = jest.fn().mockResolvedValue({
                stdout: 'ok',
                stderr: undefined,
                exitCode: 5,
            });
            const rc = buildE2BRemoteCommands(makeSandbox(run));
            const res = await rc.exec('cmd');
            expect(res).toEqual({ stdout: 'ok', stderr: '', exitCode: 5 });
        });
    });
});

// ---------------------------------------------------------------------------
// buildRemoteCommands (private, delegates to buildE2BRemoteCommands)
// ---------------------------------------------------------------------------
describe('E2BSandboxService.buildRemoteCommands', () => {
    it('returns a RemoteCommands object wired to the given sandbox', async () => {
        const service = new E2BSandboxService({} as any);
        const run = jest
            .fn()
            .mockResolvedValue({ stdout: 'body', stderr: '', exitCode: 0 });
        const sandbox = { commands: { run } } as any;

        const rc = (service as any).buildRemoteCommands(sandbox);
        expect(typeof rc.grep).toBe('function');
        expect(typeof rc.read).toBe('function');
        expect(typeof rc.listDir).toBe('function');
        expect(typeof rc.exec).toBe('function');

        // Prove the delegate actually drives THIS sandbox and resolves paths
        // against REPO_DIR, not the sandbox CWD.
        await rc.read('src/a.ts', 0, 0);
        expect(run).toHaveBeenCalledWith(`cat '${REPO_DIR}/src/a.ts'`, {
            timeoutMs: 10_000,
        });
    });
});
