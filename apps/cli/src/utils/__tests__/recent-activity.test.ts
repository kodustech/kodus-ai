import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function importRecentActivityModule(
    homeDir: string,
): Promise<typeof import('../recent-activity.js')> {
    vi.resetModules();
    vi.doMock('node:os', async () => {
        const actual = await vi.importActual<any>('node:os');
        return {
            ...actual,
            homedir: () => homeDir,
            default: {
                ...actual,
                homedir: () => homeDir,
            },
        };
    });

    return import('../recent-activity.js');
}

describe('recent activity utils', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        vi.doUnmock('node:os');
        vi.restoreAllMocks();
        vi.resetModules();

        while (tempDirs.length > 0) {
            const dir = tempDirs.pop()!;
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it('returns fallback line when there is no activity', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-recent-activity-test-'),
        );
        tempDirs.push(home);
        const { loadRecentActivity, getRecentActivityLines } =
            await importRecentActivityModule(home);

        await expect(loadRecentActivity()).resolves.toEqual([]);
        await expect(getRecentActivityLines(2)).resolves.toEqual([
            'No recent activity yet',
        ]);
    });

    it('records and reads recent commands in reverse chronological order', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-recent-activity-test-'),
        );
        tempDirs.push(home);
        const {
            recordRecentActivity,
            loadRecentActivity,
            getRecentActivityLines,
        } = await importRecentActivityModule(home);

        await recordRecentActivity(['review', '--fast']);
        await recordRecentActivity(['auth', 'status']);

        const entries = await loadRecentActivity();
        expect(entries).toHaveLength(2);
        expect(entries[0]?.command).toBe('kodus auth status');
        expect(entries[1]?.command).toBe('kodus review --fast');

        const lines = await getRecentActivityLines(2);
        expect(lines[0]).toMatch(/^kodus auth status - /);
        expect(lines[1]).toMatch(/^kodus review --fast - /);
    });

    it('redacts sensitive flag values when storing commands', async () => {
        const home = await fs.mkdtemp(
            path.join(os.tmpdir(), 'kodus-recent-activity-test-'),
        );
        tempDirs.push(home);
        const { recordRecentActivity, loadRecentActivity } =
            await importRecentActivityModule(home);

        await recordRecentActivity([
            'auth',
            'team-key',
            '--key',
            'kodus_secret_123',
        ]);
        const [entry] = await loadRecentActivity();

        expect(entry?.command).toBe('kodus auth team-key --key [REDACTED]');
    });
});
