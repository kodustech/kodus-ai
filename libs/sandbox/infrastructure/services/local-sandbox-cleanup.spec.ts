import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    isLocalSandboxPath,
    deleteLocalSandbox,
} from './local-sandbox-cleanup.service';

describe('isLocalSandboxPath', () => {
    it('accepts a valid local sandbox path', () => {
        const tmpDir = os.tmpdir();
        expect(
            isLocalSandboxPath(path.join(tmpDir, 'kodus-sandbox-abc123')),
        ).toBe(true);
    });

    it('rejects null/undefined', () => {
        expect(isLocalSandboxPath(null)).toBe(false);
        expect(isLocalSandboxPath(undefined)).toBe(false);
    });

    it('rejects empty string', () => {
        expect(isLocalSandboxPath('')).toBe(false);
    });

    it('rejects path outside tmpdir', () => {
        expect(isLocalSandboxPath('/var/kodus-sandbox-abc')).toBe(false);
    });

    it('rejects path traversal', () => {
        const tmpDir = os.tmpdir();
        expect(
            isLocalSandboxPath(
                path.join(tmpDir, 'kodus-sandbox-abc', '..', '..', 'etc'),
            ),
        ).toBe(false);
    });

    it('rejects wrong prefix', () => {
        const tmpDir = os.tmpdir();
        expect(isLocalSandboxPath(path.join(tmpDir, 'other-dir'))).toBe(false);
    });

    it('rejects nested path', () => {
        const tmpDir = os.tmpdir();
        expect(
            isLocalSandboxPath(
                path.join(tmpDir, 'kodus-sandbox-abc', 'subdir'),
            ),
        ).toBe(false);
    });
});

describe('deleteLocalSandbox', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-sandbox-test-'),
        );
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    it('deletes an existing sandbox directory', async () => {
        await expect(fs.access(tmpDir)).resolves.toBeUndefined();
        await deleteLocalSandbox(tmpDir);
        await expect(fs.access(tmpDir)).rejects.toThrow();
    });

    it('succeeds when directory is already gone', async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
        await expect(deleteLocalSandbox(tmpDir)).resolves.toBeUndefined();
    });

    it('rejects invalid path', async () => {
        await expect(deleteLocalSandbox('/etc/passwd')).rejects.toThrow(
            /Invalid local sandbox path/,
        );
    });
});
