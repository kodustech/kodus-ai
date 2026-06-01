import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

vi.mock('../../services/git.service.js', () => ({
    gitService: {
        isGitRepository: vi.fn().mockResolvedValue(true),
        getGitRoot: vi.fn(),
    },
}));

vi.mock('../memory/session-hooks-install.js', () => ({
    removeSessionHooks: vi.fn().mockResolvedValue({ removed: false }),
}));

import { gitService } from '../../services/git.service.js';
import { disableAction } from '../memory/disable.js';
import {
    CODEX_NOTIFY_LINE,
    CODEX_NOTIFY_LINE_LEGACY,
} from '../memory/hooks.js';

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-disable-test-'));
    await fs.mkdir(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
    vi.mocked(gitService.getGitRoot).mockResolvedValue(tmpDir);

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
    it('removes Claude hooks from settings.json', async () => {
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
                                            'kodus decisions capture --agent claude-compatible --event stop',
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

    it('removes Codex notify line', async () => {
        const codexPath = path.join(tmpDir, '.codex', 'config.toml');
        await fs.mkdir(path.dirname(codexPath), { recursive: true });
        await fs.writeFile(
            codexPath,
            `model = "gpt-4"\n${CODEX_NOTIFY_LINE}\n`,
        );

        await disableAction();

        const content = await fs.readFile(codexPath, 'utf-8');
        expect(content).not.toContain(CODEX_NOTIFY_LINE);
        expect(content).toContain('model = "gpt-4"');
    });

    it('removes legacy Codex notify line', async () => {
        const codexPath = path.join(tmpDir, '.codex', 'config.toml');
        await fs.mkdir(path.dirname(codexPath), { recursive: true });
        await fs.writeFile(
            codexPath,
            `model = "gpt-4"\n${CODEX_NOTIFY_LINE_LEGACY}\n`,
        );

        await disableAction();

        const content = await fs.readFile(codexPath, 'utf-8');
        expect(content).not.toContain(CODEX_NOTIFY_LINE_LEGACY);
        expect(content).toContain('model = "gpt-4"');
    });

    it('is idempotent (disable when nothing installed reports not found)', async () => {
        await disableAction();

        const calls = vi.mocked(console.log).mock.calls.flat().join('\n');
        expect(calls).toContain('not found');
    });
});
