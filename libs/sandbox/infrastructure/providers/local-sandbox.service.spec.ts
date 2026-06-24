import { PlatformType } from '@libs/core/domain/enums';
import { LocalSandboxService } from './local-sandbox.service';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

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

describe('LocalSandboxService.connectToExistingSandbox', () => {
    const service = new LocalSandboxService({} as any);

    it('reconnects to an existing local sandbox directory', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'kodus-sandbox-test-'));

        try {
            await writeFile(join(tempDir, 'README.md'), 'hello', 'utf-8');

            const sandbox = await service.connectToExistingSandbox(tempDir);

            expect(sandbox.type).toBe('local');
            expect(sandbox.sandboxId).toBe(tempDir);
            expect(sandbox.repoDir).toBe(tempDir);
            await expect(sandbox.readFile('README.md')).resolves.toBe('hello');
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it('rejects unsafe reconnect paths', async () => {
        await expect(
            service.connectToExistingSandbox('/tmp/not-kodus-sandbox-test'),
        ).rejects.toThrow(/unsafe sandbox path/i);
    });

    it('keeps local read and write operations inside the sandbox directory', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'kodus-sandbox-test-'));

        try {
            const sandbox = await service.connectToExistingSandbox(tempDir);

            await sandbox.writeFile('src/file.txt', 'content');
            await expect(
                readFile(join(tempDir, 'src/file.txt'), 'utf-8'),
            ).resolves.toBe('content');

            await expect(sandbox.readFile('/etc/passwd')).rejects.toThrow(
                /absolute paths/i,
            );
            await expect(
                sandbox.writeFile('../outside.txt', 'content'),
            ).rejects.toThrow(/path traversal/i);
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it('does not expose host secrets to sandbox.run commands', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'kodus-sandbox-test-'));
        const oldSecret = process.env.KODUS_LOCAL_SANDBOX_SECRET_TEST;

        try {
            process.env.KODUS_LOCAL_SANDBOX_SECRET_TEST = 'secret-value';

            const sandbox = await service.connectToExistingSandbox(tempDir);
            const result = await sandbox.run(
                'node -e "process.stdout.write(process.env.KODUS_LOCAL_SANDBOX_SECRET_TEST || \'\')"',
            );

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toBe('');
        } finally {
            if (oldSecret === undefined) {
                delete process.env.KODUS_LOCAL_SANDBOX_SECRET_TEST;
            } else {
                process.env.KODUS_LOCAL_SANDBOX_SECRET_TEST = oldSecret;
            }
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it('refuses to write through a symlink that points outside the sandbox directory', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'kodus-sandbox-test-'));
        const outsideDir = await mkdtemp(join(tmpdir(), 'kodus-outside-test-'));
        const outsideFile = join(outsideDir, 'outside.txt');

        try {
            await writeFile(outsideFile, 'original', 'utf-8');
            await symlink(outsideFile, join(tempDir, 'linked.txt'));

            const sandbox = await service.connectToExistingSandbox(tempDir);

            await expect(
                sandbox.writeFile('linked.txt', 'overwritten'),
            ).rejects.toBeDefined();
            await expect(readFile(outsideFile, 'utf-8')).resolves.toBe(
                'original',
            );
        } finally {
            await rm(tempDir, { recursive: true, force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });

    it('refuses to create parent directories through a symlink outside the sandbox directory', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'kodus-sandbox-test-'));
        const outsideDir = await mkdtemp(join(tmpdir(), 'kodus-outside-test-'));

        try {
            await symlink(outsideDir, join(tempDir, 'linked-dir'));

            const sandbox = await service.connectToExistingSandbox(tempDir);

            await expect(
                sandbox.writeFile('linked-dir/new-dir/file.txt', 'content'),
            ).rejects.toThrow(/path escapes repo boundary/i);
            await expect(
                stat(join(outsideDir, 'new-dir')),
            ).rejects.toMatchObject({
                code: 'ENOENT',
            });
        } finally {
            await rm(tempDir, { recursive: true, force: true });
            await rm(outsideDir, { recursive: true, force: true });
        }
    });
});
