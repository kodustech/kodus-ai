import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PlatformType } from '@libs/core/domain/enums';
import { LocalSandboxService } from './local-sandbox.service';

/**
 * buildAuthHeader is the git-over-HTTPS Authorization builder used when the
 * local sandbox clones a repo. The Bitbucket branch is the regression guard
 * for #1168: Atlassian API tokens (ATATT…) authenticate to git ONLY with the
 * literal username `x-bitbucket-api-token-auth`, NOT the account email/username
 * the REST API accepts. Getting this wrong yields a silent anonymous clone and
 * `fatal: could not read Username`.
 */
describe('LocalSandboxService.buildAuthHeader', () => {
    const service = new LocalSandboxService({} as any);
    // Private method — exercise it directly.
    const build = (platform: PlatformType, token: string, username?: string) =>
        (service as any).buildAuthHeader(platform, token, username) as string;

    const decode = (header: string) =>
        Buffer.from(
            header.replace('Authorization: Basic ', ''),
            'base64',
        ).toString('utf8');

    it('uses x-access-token for GitHub', () => {
        expect(decode(build(PlatformType.GITHUB, 'ghtok'))).toBe(
            'x-access-token:ghtok',
        );
    });

    it('uses oauth2 for GitLab and Azure', () => {
        expect(decode(build(PlatformType.GITLAB, 'gltok'))).toBe(
            'oauth2:gltok',
        );
        expect(decode(build(PlatformType.AZURE_REPOS, 'aztok'))).toBe(
            'oauth2:aztok',
        );
    });

    describe('Bitbucket (#1168)', () => {
        it('uses x-bitbucket-api-token-auth for Atlassian API tokens (ATATT…), ignoring the stored email/username', () => {
            const header = build(
                PlatformType.BITBUCKET,
                'ATATT3xFfGF0token',
                'gabriel.malinosqui@kodus.io', // REST-API identity — must NOT be used for git
            );
            expect(decode(header)).toBe(
                'x-bitbucket-api-token-auth:ATATT3xFfGF0token',
            );
        });

        it('uses the account username for classic app passwords', () => {
            expect(
                decode(
                    build(PlatformType.BITBUCKET, 'classicapppw', 'kodususer'),
                ),
            ).toBe('kodususer:classicapppw');
        });

        it('still works for an API token even when no username is provided', () => {
            expect(decode(build(PlatformType.BITBUCKET, 'ATATTabc'))).toBe(
                'x-bitbucket-api-token-auth:ATATTabc',
            );
        });

        it('throws for a classic app password with no username (cannot build valid git auth)', () => {
            expect(() => build(PlatformType.BITBUCKET, 'classicpw')).toThrow(
                /Bitbucket authentication requires/i,
            );
        });
    });
});

describe('LocalSandboxService sandbox file access', () => {
    let dir: string;
    let outsideDir: string;
    let sandbox: {
        readFile: (path: string) => Promise<string>;
        writeFile: (path: string, content: string) => Promise<void>;
    };

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-sandbox-files-'));
        outsideDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'kodus-sandbox-outside-'),
        );
        const svc = new LocalSandboxService({} as any);
        sandbox = (svc as any).buildSandboxFileAccess(dir);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it('reads a repo-relative file', async () => {
        fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
        await expect(sandbox.readFile('a.txt')).resolves.toBe('hello');
    });

    it('writes a repo-relative file and creates parent directories', async () => {
        await sandbox.writeFile('sub/b.txt', 'world');
        expect(fs.readFileSync(path.join(dir, 'sub/b.txt'), 'utf-8')).toBe(
            'world',
        );
    });

    it('hands openRepoWriteHandle a path under the REAL repo root when repoDir is a symlink (#1532 regression)', async () => {
        // A repo root reached through a symlink — e.g. a symlinked temp mount
        // on Linux/CI. resolveSafeWritePath returns a repoDir-prefixed path; if
        // that is handed straight to the openat helper, its
        // relative(repoReal, …) guard sees a leading `..` and rejects an
        // otherwise-legitimate write. The path handed down must live under the
        // realpath-resolved root.
        const realRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'kodus-sandbox-real-'),
        );
        const linkRoot = path.join(
            os.tmpdir(),
            'kodus-sandbox-link-' + path.basename(realRoot),
        );
        fs.symlinkSync(realRoot, linkRoot);
        try {
            const svc = new LocalSandboxService({} as any);
            const spy = jest.spyOn(svc as any, 'openRepoWriteHandle');
            const symSandbox = (svc as any).buildSandboxFileAccess(linkRoot);

            await symSandbox.writeFile('sub/c.txt', 'ok');

            const repoReal = fs.realpathSync(linkRoot);
            const passedSafePath = spy.mock.calls[0][1] as string;
            const rel = path.relative(repoReal, passedSafePath);
            expect(rel.startsWith('..')).toBe(false);
            expect(path.isAbsolute(rel)).toBe(false);
            // …and the write actually lands in the real repo tree.
            expect(
                fs.readFileSync(path.join(realRoot, 'sub/c.txt'), 'utf-8'),
            ).toBe('ok');
        } finally {
            fs.unlinkSync(linkRoot);
            fs.rmSync(realRoot, { recursive: true, force: true });
        }
    });

    it('writes a nested file through a symlinked repoDir end-to-end (#1532)', async () => {
        // Behavioural black-box: the write must succeed and land in the real
        // tree even when the sandbox root is reached through a symlink.
        const realRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'kodus-sandbox-real-'),
        );
        const linkRoot = path.join(
            os.tmpdir(),
            'kodus-sandbox-link-' + path.basename(realRoot),
        );
        fs.symlinkSync(realRoot, linkRoot);
        try {
            const svc = new LocalSandboxService({} as any);
            const symSandbox = (svc as any).buildSandboxFileAccess(linkRoot);
            await symSandbox.writeFile('deep/nested/file.txt', 'ok');
            expect(
                fs.readFileSync(
                    path.join(realRoot, 'deep/nested/file.txt'),
                    'utf-8',
                ),
            ).toBe('ok');
        } finally {
            fs.unlinkSync(linkRoot);
            fs.rmSync(realRoot, { recursive: true, force: true });
        }
    });

    it('still rejects a symlinked target file when repoDir is a symlink (fix must not open a hole)', async () => {
        // Security guard: the symlinked-repoDir normalization must NOT let a
        // symlinked target file be written through — the escape must still throw
        // and the outside secret must stay untouched.
        const realRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'kodus-sandbox-real-'),
        );
        const linkRoot = path.join(
            os.tmpdir(),
            'kodus-sandbox-link-' + path.basename(realRoot),
        );
        fs.symlinkSync(realRoot, linkRoot);
        const secretDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'kodus-sandbox-secret-'),
        );
        const secret = path.join(secretDir, 'secret.txt');
        fs.writeFileSync(secret, 'secret');
        fs.symlinkSync(secret, path.join(realRoot, 'linkfile.txt'));
        try {
            const svc = new LocalSandboxService({} as any);
            const symSandbox = (svc as any).buildSandboxFileAccess(linkRoot);
            await expect(
                symSandbox.writeFile('linkfile.txt', 'x'),
            ).rejects.toThrow(/Symlink/);
            expect(fs.readFileSync(secret, 'utf-8')).toBe('secret');
        } finally {
            fs.unlinkSync(linkRoot);
            fs.rmSync(realRoot, { recursive: true, force: true });
            fs.rmSync(secretDir, { recursive: true, force: true });
        }
    });

    it('rejects absolute read paths outside the repo', async () => {
        await expect(sandbox.readFile('/etc/passwd')).rejects.toThrow(
            /Absolute paths are not allowed/,
        );
    });

    it('rejects absolute write paths outside the repo', async () => {
        await expect(sandbox.writeFile('/etc/passwd', 'x')).rejects.toThrow(
            /Absolute paths are not allowed/,
        );
    });

    it('accepts absolute paths that resolve inside the repo (read)', async () => {
        const absPath = path.join(dir, 'a.txt');
        fs.writeFileSync(absPath, 'hello');
        await expect(sandbox.readFile(absPath)).resolves.toBe('hello');
    });

    it('accepts absolute paths that resolve inside the repo (write)', async () => {
        const absPath = path.join(dir, 'sub', 'c.txt');
        await sandbox.writeFile(absPath, 'content');
        expect(fs.readFileSync(absPath, 'utf-8')).toBe('content');
    });

    it('rejects absolute paths with .. traversal even under repoDir', async () => {
        const escapePath = dir + '/../outside';
        await expect(sandbox.readFile(escapePath)).rejects.toThrow(
            /Path traversal using ".." is not allowed/,
        );
    });

    it('rejects absolute write paths with .. traversal even under repoDir', async () => {
        const escapePath = dir + '/../outside';
        await expect(sandbox.writeFile(escapePath, 'x')).rejects.toThrow(
            /Path traversal using ".." is not allowed/,
        );
    });

    it('rejects .. traversal reads', async () => {
        await expect(sandbox.readFile('../outside.txt')).rejects.toThrow(
            /Path traversal using "\.\." is not allowed/,
        );
    });

    it('rejects .. traversal writes', async () => {
        await expect(sandbox.writeFile('../outside.txt', 'x')).rejects.toThrow(
            /Path traversal using "\.\." is not allowed/,
        );
    });

    it('rejects reading through a symlink that escapes the repo', async () => {
        const outsideFile = path.join(outsideDir, 'secret.txt');
        fs.writeFileSync(outsideFile, 'secret');
        fs.symlinkSync(outsideFile, path.join(dir, 'escape-link'));
        await expect(sandbox.readFile('escape-link')).rejects.toThrow(
            /Symlink detected/,
        );
    });

    it('rejects writing through a symlinked parent directory', async () => {
        fs.symlinkSync(outsideDir, path.join(dir, 'linkdir'));
        await expect(
            sandbox.writeFile('linkdir/nested/file.txt', 'x'),
        ).rejects.toThrow(/Symlink/);
    });

    it('rejects overwriting a symlinked target file', async () => {
        const outsideFile = path.join(outsideDir, 'target.txt');
        fs.writeFileSync(outsideFile, 'secret');
        fs.symlinkSync(outsideFile, path.join(dir, 'linkfile.txt'));
        await expect(sandbox.writeFile('linkfile.txt', 'x')).rejects.toThrow(
            /Symlink/,
        );
    });

    it('writes a new file under an existing safe parent directory', async () => {
        fs.mkdirSync(path.join(dir, 'safe'));
        await sandbox.writeFile('safe/new.txt', 'ok');
        expect(fs.readFileSync(path.join(dir, 'safe/new.txt'), 'utf-8')).toBe(
            'ok',
        );
    });

    it('rejects write when parent directory realpath escapes repo after mkdir (TOCTOU post-mkdir check)', async () => {
        const fsPromises = require('fs/promises');
        const originalRealpath = fsPromises.realpath;
        // Track the nested subdir path — the post-mkdir finalCheck resolves
        // the immediate parent of the target file.
        const nestedDir = path.join(dir, 'escape', 'nested');

        jest.spyOn(fsPromises, 'realpath').mockImplementation(
            (async (p: string) => {
                if (p === nestedDir) {
                    return '/tmp/outside-escape';
                }
                return originalRealpath(p);
            }) as unknown as typeof fsPromises.realpath,
        );

        try {
            await expect(
                sandbox.writeFile('escape/nested/file.txt', 'pwned'),
            ).rejects.toThrow(/Path escapes repo boundary after mkdir/);
        } finally {
            jest.restoreAllMocks();
        }
    });
});

/**
 * Repo-boundary checks must be correct on every host OS (Linux/macOS/Windows),
 * not just POSIX. The previous `startsWith(root + '/')` form hard-coded the
 * POSIX separator, so on Windows (backslash paths from `path`/`fs.realpath`) it
 * treated every in-repo path as an escape — which made the write path's
 * parent-symlink loop `break` early and skip its checks. `isPathInside` decides
 * containment with `path.relative` instead, which is separator-agnostic.
 *
 * The service method uses the current platform's `path`, so on a POSIX CI it
 * only exercises POSIX. To prove the algorithm holds on Windows too, the
 * cross-platform block re-runs the exact same relative-based predicate against
 * `path.win32` and `path.posix` explicitly.
 */
describe('LocalSandboxService.isPathInside', () => {
    const service = new LocalSandboxService({} as any);
    const isInside = (root: string, child: string): boolean =>
        (service as any).isPathInside(root, child);

    it('accepts the root itself and nested children (POSIX)', () => {
        expect(isInside('/repo', '/repo')).toBe(true);
        expect(isInside('/repo', '/repo/a/b.ts')).toBe(true);
    });

    it('rejects escapes and sibling dirs (POSIX)', () => {
        expect(isInside('/repo', '/repo/../etc/passwd')).toBe(false);
        expect(isInside('/repo', '/repo-legacy/x')).toBe(false);
        expect(isInside('/repo', '/etc/passwd')).toBe(false);
    });

    describe('algorithm is separator-agnostic (Linux/macOS/Windows)', () => {
        const predicate = (
            mod: typeof path.posix | typeof path.win32,
            root: string,
            child: string,
        ): boolean => {
            const rel = mod.relative(root, child);
            return rel === '' || (!rel.startsWith('..') && !mod.isAbsolute(rel));
        };

        it('holds under POSIX separators', () => {
            expect(predicate(path.posix, '/repo', '/repo/a/b')).toBe(true);
            expect(predicate(path.posix, '/repo', '/repo/../x')).toBe(false);
            expect(predicate(path.posix, '/repo', '/repo-legacy/x')).toBe(
                false,
            );
        });

        it('holds under Windows separators — where startsWith("/") failed', () => {
            // In-repo child: the old `startsWith(root + '/')` returned false
            // here (backslash), silently flagging a valid path as an escape.
            expect(predicate(path.win32, 'C:\\repo', 'C:\\repo\\a\\b')).toBe(
                true,
            );
            expect(predicate(path.win32, 'C:\\repo', 'C:\\repo')).toBe(true);
            // Real escapes still rejected.
            expect(predicate(path.win32, 'C:\\repo', 'C:\\repo\\..\\etc')).toBe(
                false,
            );
            // Different drive → `relative` returns an absolute path → rejected.
            expect(predicate(path.win32, 'C:\\repo', 'D:\\repo\\x')).toBe(false);
        });
    });
});

/**
 * openRepoWriteHandle emulates openat(2) on Linux to close the parent-dir-swap
 * TOCTOU (#1532): it descends the path one component at a time refusing to
 * follow a symlink, so an intermediate directory that is (or is swapped for) a
 * symlink after validation fails instead of redirecting the write outside the
 * repo. `/proc/self/fd` is Linux-only, so these run only on Linux; other hosts
 * use the best-effort fallback covered by the O_NOFOLLOW tests above.
 */
const onLinux = process.platform === 'linux' ? describe : describe.skip;
onLinux('LocalSandboxService.openRepoWriteHandle (Linux openat)', () => {
    let dir: string;
    let outsideDir: string;
    let svc: LocalSandboxService;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-openat-'));
        outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-openat-out-'));
        svc = new LocalSandboxService({} as any);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    const openWrite = (repoReal: string, target: string): Promise<any> =>
        (svc as any).openRepoWriteHandle(repoReal, target);

    it('writes a file under a real nested directory', async () => {
        fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
        const repoReal = fs.realpathSync(dir);
        const target = path.join(repoReal, 'a', 'b', 'f.txt');
        const fh = await openWrite(repoReal, target);
        try {
            await fh.writeFile('ok', 'utf-8');
        } finally {
            await fh.close();
        }
        expect(fs.readFileSync(target, 'utf-8')).toBe('ok');
    });

    it('refuses to follow a symlinked intermediate directory (openat ELOOP)', async () => {
        // `evil` is a symlink to a dir outside the repo; a write through it
        // must NOT land in outsideDir — the O_NOFOLLOW hop rejects it.
        fs.symlinkSync(outsideDir, path.join(dir, 'evil'));
        const repoReal = fs.realpathSync(dir);
        const target = path.join(repoReal, 'evil', 'pwned.txt');
        await expect(openWrite(repoReal, target)).rejects.toThrow();
        expect(fs.existsSync(path.join(outsideDir, 'pwned.txt'))).toBe(false);
    });

    it('refuses to follow a symlinked FINAL component', async () => {
        const outsideFile = path.join(outsideDir, 'target.txt');
        fs.writeFileSync(outsideFile, 'secret');
        fs.symlinkSync(outsideFile, path.join(dir, 'link.txt'));
        const repoReal = fs.realpathSync(dir);
        await expect(
            openWrite(repoReal, path.join(repoReal, 'link.txt')),
        ).rejects.toThrow();
        expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('secret');
    });
});
