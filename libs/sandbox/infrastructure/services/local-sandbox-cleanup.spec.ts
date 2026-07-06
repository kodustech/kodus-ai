import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
    cleanupLocalSandboxDirectory,
    isLocalSandboxPath,
    localSandboxDirectoryExists,
} from './local-sandbox-cleanup';

describe('local sandbox cleanup helpers', () => {
    it('accepts only kodus sandbox directories directly under the OS tmp root', () => {
        expect(isLocalSandboxPath(join(tmpdir(), 'kodus-sandbox-abc'))).toBe(
            true,
        );
        expect(isLocalSandboxPath(join(tmpdir(), 'not-kodus-abc'))).toBe(false);
        expect(isLocalSandboxPath('/var/tmp/kodus-sandbox-abc')).toBe(false);
        expect(isLocalSandboxPath('kodus-sandbox-abc')).toBe(false);
        expect(isLocalSandboxPath(undefined)).toBe(false);
    });

    it('removes an existing local sandbox directory and reports success', async () => {
        const sandboxId = await mkdtemp(join(tmpdir(), 'kodus-sandbox-'));

        await expect(localSandboxDirectoryExists(sandboxId)).resolves.toBe(
            true,
        );
        await expect(cleanupLocalSandboxDirectory(sandboxId)).resolves.toBe(
            true,
        );
        await expect(localSandboxDirectoryExists(sandboxId)).resolves.toBe(
            false,
        );
    });

    it('returns false for a missing local sandbox directory', async () => {
        const sandboxId = await mkdtemp(join(tmpdir(), 'kodus-sandbox-'));
        await rm(sandboxId, { recursive: true, force: true });

        await expect(localSandboxDirectoryExists(sandboxId)).resolves.toBe(
            false,
        );
        await expect(cleanupLocalSandboxDirectory(sandboxId)).resolves.toBe(
            false,
        );
    });

    it('refuses invalid paths without attempting cleanup', async () => {
        await expect(cleanupLocalSandboxDirectory('/etc')).resolves.toBe(false);
        await expect(localSandboxDirectoryExists('/etc')).resolves.toBe(false);
    });
});
