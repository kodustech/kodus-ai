import { lstat, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    cleanupLocalSandboxDirectory,
    isLocalSandboxPath,
    localSandboxDirectoryExists,
} from './local-sandbox-cleanup';

describe('local sandbox cleanup guards', () => {
    it('accepts direct kodus sandbox children under the OS temp directory', () => {
        expect(
            isLocalSandboxPath(join(tmpdir(), 'kodus-sandbox-test-abc')),
        ).toBe(true);
    });

    it.each([
        ['relative path', 'kodus-sandbox-test-abc'],
        ['wrong prefix', join(tmpdir(), 'not-kodus-sandbox-test-abc')],
        [
            'nested temp child',
            join(tmpdir(), 'nested', 'kodus-sandbox-test-abc'),
        ],
        ['outside temp directory', '/var/tmp/kodus-sandbox-test-abc'],
    ])('rejects unsafe local sandbox path: %s', (_label, sandboxId) => {
        expect(isLocalSandboxPath(sandboxId)).toBe(false);
    });

    it('removes an existing local sandbox directory and reports success', async () => {
        const sandboxId = await mkdtemp(join(tmpdir(), 'kodus-sandbox-test-'));

        await expect(cleanupLocalSandboxDirectory(sandboxId)).resolves.toBe(
            true,
        );
        await expect(lstat(sandboxId)).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('reports false when the local sandbox directory is missing', async () => {
        const sandboxId = await mkdtemp(join(tmpdir(), 'kodus-sandbox-test-'));
        await rm(sandboxId, { recursive: true, force: true });

        await expect(cleanupLocalSandboxDirectory(sandboxId)).resolves.toBe(
            false,
        );
        await expect(localSandboxDirectoryExists(sandboxId)).resolves.toBe(
            false,
        );
    });

    it('reports false for unsafe paths without touching them', async () => {
        await expect(
            cleanupLocalSandboxDirectory('/var/tmp/kodus-sandbox-test-abc'),
        ).resolves.toBe(false);
    });
});
