import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function importConfigModule(
    homeDir: string,
): Promise<typeof import('../config.js')> {
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

    return import('../config.js');
}

describe('config utils', () => {
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

    it('returns null when config file does not exist', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-config-test-'),
        );
        tempDirs.push(home);
        const { loadConfig } = await importConfigModule(home);

        await expect(loadConfig()).resolves.toBeNull();
    });

    it('saves and loads config successfully', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-config-test-'),
        );
        tempDirs.push(home);
        const { saveConfig, loadConfig } = await importConfigModule(home);

        const input = {
            teamKey: 'kodus_abc123',
            teamName: 'Platform Team',
            organizationName: 'Kodus',
        };

        await saveConfig(input);
        const loaded = await loadConfig();

        expect(loaded).toEqual(input);
    });

    it('writes config atomically without leaving temp files', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-config-test-'),
        );
        tempDirs.push(home);
        const { saveConfig } = await importConfigModule(home);

        await saveConfig({
            teamKey: 'kodus_abc123',
            teamName: 'Platform Team',
            organizationName: 'Kodus',
        });

        const configDir = path.join(home, '.kodus');
        const files = await fs.readdir(configDir);
        expect(files.some((f) => f.includes('.tmp'))).toBe(false);
        expect(files).toContain('config.json');
    });

    it('saves and loads config with apiUrl and Cloudflare Access fields', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-config-test-'),
        );
        tempDirs.push(home);
        const { saveConfig, loadConfig } = await importConfigModule(home);

        const input = {
            teamKey: 'kodus_abc123',
            teamName: 'Platform Team',
            organizationName: 'Kodus',
            apiUrl: 'https://kodus.example.com',
            cfAccessClientId: 'my-client-id',
            cfAccessClientSecret: 'my-client-secret',
        };

        await saveConfig(input);
        const loaded = await loadConfig();

        expect(loaded).toEqual(input);
    });

    it('self-heals malformed JSON by isolating corrupted config', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-config-test-'),
        );
        tempDirs.push(home);
        const { loadConfig } = await importConfigModule(home);

        const configDir = path.join(home, '.kodus');
        const configFile = path.join(configDir, 'config.json');
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(configFile, '{ malformed-json ', 'utf-8');

        const loaded = await loadConfig();
        expect(loaded).toBeNull();

        const files = await fs.readdir(configDir);
        expect(files).not.toContain('config.json');
        expect(files.some((f) => f.startsWith('config.json.corrupted.'))).toBe(
            true,
        );
    });
});
