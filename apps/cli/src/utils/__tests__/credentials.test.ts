import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function importCredentialsModule(
    homeDir: string,
): Promise<typeof import('../credentials.js')> {
    vi.resetModules();
    vi.doMock('os', async () => {
        const actual = await vi.importActual<any>('os');
        return {
            ...actual,
            homedir: () => homeDir,
            default: {
                ...actual,
                homedir: () => homeDir,
            },
        };
    });

    return import('../credentials.js');
}

describe('credentials utils', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        vi.doUnmock('os');
        vi.restoreAllMocks();
        vi.resetModules();

        while (tempDirs.length > 0) {
            const dir = tempDirs.pop()!;
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it('returns null when credentials file does not exist', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-credentials-test-'),
        );
        tempDirs.push(home);
        const { loadCredentials } = await importCredentialsModule(home);

        await expect(loadCredentials()).resolves.toBeNull();
    });

    it('saves and loads credentials successfully', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-credentials-test-'),
        );
        tempDirs.push(home);
        const { saveCredentials, loadCredentials } =
            await importCredentialsModule(home);

        const input = {
            accessToken: 'access',
            refreshToken: 'refresh',
            expiresAt: Date.now() + 60 * 60 * 1000,
            user: {
                id: 'u1',
                email: 'dev@kodus.io',
                orgs: ['Kodus'],
            },
        };

        await saveCredentials(input);
        const loaded = await loadCredentials();

        expect(loaded).toEqual(input);
    });

    it('writes credentials atomically without leaving temp files', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-credentials-test-'),
        );
        tempDirs.push(home);
        const { saveCredentials } = await importCredentialsModule(home);

        await saveCredentials({
            accessToken: 'access',
            refreshToken: 'refresh',
            expiresAt: Date.now() + 60 * 60 * 1000,
            user: {
                id: 'u1',
                email: 'dev@kodus.io',
                orgs: ['Kodus'],
            },
        });

        const configDir = path.join(home, '.kodus');
        const files = await fs.readdir(configDir);
        expect(files.some((f) => f.includes('.tmp'))).toBe(false);
        expect(files).toContain('credentials.json');
    });

    it('self-heals malformed JSON by isolating corrupted credentials', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-credentials-test-'),
        );
        tempDirs.push(home);
        const { loadCredentials } = await importCredentialsModule(home);

        const configDir = path.join(home, '.kodus');
        const credentialsFile = path.join(configDir, 'credentials.json');
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(credentialsFile, '{ malformed-json ', 'utf-8');

        const loaded = await loadCredentials();
        expect(loaded).toBeNull();

        const files = await fs.readdir(configDir);
        expect(files).not.toContain('credentials.json');
        expect(
            files.some((f) => f.startsWith('credentials.json.corrupted.')),
        ).toBe(true);
    });
});
