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
import { CODEX_NOTIFY_LINE_LEGACY_VARIANTS } from '../trace/hooks.js';
import { gitHooksService } from '../../services/git-hooks.service.js';

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-disable-test-'));
    await fs.mkdir(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
    vi.mocked(gitService.getGitRoot).mockResolvedValue(tmpDir);
    vi.mocked(gitService.getHooksDir).mockResolvedValue(
        path.join(tmpDir, '.git', 'hooks'),
    );

    // Override HOME so resolveCodexConfigPath points to tmpDir
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('disableAction', () => {
    it('removes hooks from settings.json, including the previous release', async () => {
        const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.writeFile(
            settingsPath,
            JSON.stringify(
                {
                    hooks: {
                        UserPromptSubmit: [
                            {
                                matcher: '',
                                hooks: [
                                    {
                                        type: 'command',
                                        command:
                                            'kodus decisions capture --agent claude-compatible --event user-prompt-submit',
                                    },
                                ],
                            },
                        ],
                        Stop: [
                            {
                                matcher: '',
                                hooks: [
                                    {
                                        type: 'command',
                                        command:
                                            'kodus trace hooks claude-code stop',
                                    },
                                ],
                            },
                        ],
                    },
                },
                null,
                2,
            ),
        );

        await disableAction();

        const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
        expect(settings.hooks).toBeUndefined();
    });

    it('removes the legacy Codex notify line', async () => {
        const codexPath = path.join(tmpDir, '.codex', 'config.toml');
        await fs.mkdir(path.dirname(codexPath), { recursive: true });
        await fs.writeFile(
            codexPath,
            `model = "gpt-4"\n${CODEX_NOTIFY_LINE_LEGACY_VARIANTS[2]}\n`,
        );

        await disableAction();

        const content = await fs.readFile(codexPath, 'utf-8');
        expect(content).not.toContain('notify =');
        expect(content).toContain('model = "gpt-4"');
    });

    it('removes the git hooks it installed', async () => {
        const hooksDir = path.join(tmpDir, '.git', 'hooks');
        await gitHooksService.install(hooksDir);

        await disableAction();

        await expect(
            fs.access(path.join(hooksDir, 'prepare-commit-msg')),
        ).rejects.toThrow();
        await expect(
            fs.access(path.join(hooksDir, 'pre-push')),
        ).rejects.toThrow();
    });

    it('is idempotent (disable when nothing installed reports not found)', async () => {
        await disableAction();

        const calls = vi.mocked(console.log).mock.calls.flat().join('\n');
        expect(calls).toContain('not found');
    });
});
