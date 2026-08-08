import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

vi.mock('../../services/git.service.js', () => ({
    gitService: {
        isGitRepository: vi.fn().mockResolvedValue(true),
        getGitRoot: vi.fn(),
        getHooksDir: vi.fn(),
    },
}));

import { gitService } from '../../services/git.service.js';
import { disableAction } from '../trace/disable.js';
import { installSessionHooks } from '../trace/session-hooks-install.js';

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-disable-test-'));
    await fs.mkdir(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
    vi.mocked(gitService.getGitRoot).mockResolvedValue(tmpDir);
    vi.mocked(gitService.getHooksDir).mockResolvedValue(
        path.join(tmpDir, '.git', 'hooks'),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('disableAction', () => {
    it('removes installed session hooks', async () => {
        await installSessionHooks(tmpDir, 'claude-code');
        const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
        const before = await fs.readFile(settingsPath, 'utf-8');
        expect(before).toContain('kodus trace hooks');

        await disableAction({});

        const after = await fs.readFile(settingsPath, 'utf-8');
        expect(after).not.toContain('kodus trace hooks');
    });

    it('strips leftover legacy decisions hooks', async () => {
        const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.writeFile(
            settingsPath,
            JSON.stringify({
                hooks: {
                    Stop: [
                        {
                            matcher: '',
                            hooks: [
                                {
                                    type: 'command',
                                    command:
                                        'kodus decisions capture --event stop',
                                },
                            ],
                        },
                    ],
                },
            }),
            'utf-8',
        );

        await disableAction({});
        const after = await fs.readFile(settingsPath, 'utf-8');
        expect(after).not.toContain('kodus decisions');
    });
});
