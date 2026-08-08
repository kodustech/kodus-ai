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
import { enableAction } from '../trace/enable.js';

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-enable-test-'));
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

describe('enableAction', () => {
    it('installs exactly one kodus command per lifecycle hook event', async () => {
        await enableAction({
            agents: 'claude',
            codexConfig: path.join(tmpDir, '.codex', 'config.toml'),
        });

        const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
        const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));

        // Lifecycle events only — no capture commands
        expect(settings.hooks).toHaveProperty('SessionStart');
        expect(settings.hooks).toHaveProperty('SessionEnd');
        expect(settings.hooks).toHaveProperty('Stop');
        expect(settings.hooks).toHaveProperty('UserPromptSubmit');

        const blob = JSON.stringify(settings.hooks);
        expect(blob).toContain('kodus trace hooks');
        expect(blob).not.toContain('kodus decisions');
        expect(blob).not.toContain('capture');

        // Count command entries — exactly one kodus command per installed event
        for (const eventKey of Object.keys(settings.hooks)) {
            for (const matcher of settings.hooks[eventKey]) {
                const kodusCmds = (matcher.hooks ?? []).filter(
                    (h: { command?: string }) =>
                        typeof h.command === 'string' &&
                        h.command.includes('kodus'),
                );
                expect(kodusCmds.length).toBeLessThanOrEqual(1);
                for (const cmd of kodusCmds) {
                    expect(cmd.command).toMatch(/^kodus trace hooks /);
                }
            }
        }
    });

    it('strips legacy kodus decisions hooks on enable', async () => {
        const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.writeFile(
            settingsPath,
            JSON.stringify(
                {
                    hooks: {
                        Stop: [
                            {
                                matcher: '',
                                hooks: [
                                    {
                                        type: 'command',
                                        command:
                                            'kodus decisions capture --capture-agent claude-compatible --event stop',
                                    },
                                    {
                                        type: 'command',
                                        command:
                                            'kodus decisions hooks claude-code stop',
                                    },
                                ],
                            },
                        ],
                        UserPromptSubmit: [
                            {
                                matcher: '',
                                hooks: [
                                    {
                                        type: 'command',
                                        command:
                                            'kodus decisions capture --capture-agent claude-compatible --event user-prompt-submit',
                                    },
                                ],
                            },
                        ],
                    },
                },
                null,
                2,
            ),
            'utf-8',
        );

        await enableAction({
            agents: 'claude',
            codexConfig: path.join(tmpDir, '.codex', 'config.toml'),
        });

        const settings = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));
        const blob = JSON.stringify(settings);
        expect(blob).not.toContain('kodus decisions');
        expect(blob).toContain('kodus trace hooks');
    });

    it('is idempotent (second run reports already configured)', async () => {
        const codexConfig = path.join(tmpDir, '.codex', 'config.toml');

        await enableAction({ agents: 'claude', codexConfig });
        await enableAction({ agents: 'claude', codexConfig });

        const calls = vi.mocked(console.log).mock.calls.flat().join('\n');
        expect(calls).toContain('already configured');
    });

    it('--agents claude skips codex', async () => {
        await enableAction({
            agents: 'claude',
            codexConfig: path.join(tmpDir, '.codex', 'config.toml'),
        });

        const calls = vi.mocked(console.log).mock.calls.flat().join('\n');
        expect(calls).toMatch(/Codex session hooks: skipped/);
    });
});
