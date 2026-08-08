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
import { CODEX_NOTIFY_LINE_LEGACY_VARIANTS } from '../trace/hooks.js';
import { TRACE_HOOK_MARKER } from '../../services/git-hooks.service.js';

let tmpDir: string;
let traceHome: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-enable-test-'));
    traceHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-enable-home-'));
    process.env.KODUS_TRACE_HOME = traceHome;
    await fs.mkdir(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
    vi.mocked(gitService.getGitRoot).mockResolvedValue(tmpDir);
    vi.mocked(gitService.getHooksDir).mockResolvedValue(
        path.join(tmpDir, '.git', 'hooks'),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
    delete process.env.KODUS_TRACE_HOME;
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(traceHome, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function claudeSettingsPath(): string {
    return path.join(tmpDir, '.claude', 'settings.json');
}

async function readClaudeCommands(): Promise<
    Array<{ event: string; matcher: string; command: string }>
> {
    const settings = JSON.parse(
        await fs.readFile(claudeSettingsPath(), 'utf-8'),
    ) as {
        hooks?: Record<
            string,
            Array<{ matcher: string; hooks: Array<{ command: string }> }>
        >;
    };

    const commands: Array<{
        event: string;
        matcher: string;
        command: string;
    }> = [];

    for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
        for (const matcher of matchers) {
            for (const hook of matcher.hooks) {
                commands.push({
                    event,
                    matcher: matcher.matcher,
                    command: hook.command,
                });
            }
        }
    }

    return commands;
}

describe('enableAction', () => {
    it('installs exactly one Kodus command per hook event', async () => {
        await enableAction({
            agents: 'claude',
            codexConfig: path.join(tmpDir, '.codex', 'config.toml'),
        });

        const commands = await readClaudeCommands();
        expect(commands.length).toBeGreaterThan(0);

        const byEventAndMatcher = new Map<string, number>();
        for (const entry of commands) {
            expect(entry.command.startsWith('kodus trace hooks')).toBe(true);
            const key = `${entry.event}::${entry.matcher}`;
            byEventAndMatcher.set(key, (byEventAndMatcher.get(key) ?? 0) + 1);
        }

        for (const [key, count] of byEventAndMatcher) {
            expect(count, `more than one Kodus command on ${key}`).toBe(1);
        }
    });

    it('installs the git hooks that carry the trailer and the distillation', async () => {
        await enableAction({
            agents: 'claude',
            codexConfig: path.join(tmpDir, '.codex', 'config.toml'),
        });

        const prepare = await fs.readFile(
            path.join(tmpDir, '.git', 'hooks', 'prepare-commit-msg'),
            'utf-8',
        );
        const prePush = await fs.readFile(
            path.join(tmpDir, '.git', 'hooks', 'pre-push'),
            'utf-8',
        );

        expect(prepare).toContain(TRACE_HOOK_MARKER);
        expect(prepare).toContain('Kodus-Trace:');
        expect(prePush).toContain('kodus trace distill');
    });

    it('strips every hook left by the previous release, including dropped events', async () => {
        await fs.mkdir(path.dirname(claudeSettingsPath()), {
            recursive: true,
        });
        await fs.writeFile(
            claudeSettingsPath(),
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
                                            'kodus decisions capture --capture-agent claude-compatible --event user-prompt-submit',
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
                        // Events this work no longer installs at all.
                        PostToolUse: [
                            {
                                matcher: 'Write',
                                hooks: [
                                    {
                                        type: 'command',
                                        command:
                                            'kodus decisions capture --capture-agent claude-compatible --event post-tool-use-write',
                                    },
                                ],
                            },
                            {
                                matcher: 'Edit',
                                hooks: [
                                    {
                                        type: 'command',
                                        command:
                                            'kodus decisions capture --capture-agent claude-compatible --event post-tool-use-edit',
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

        await enableAction({
            agents: 'claude',
            codexConfig: path.join(tmpDir, '.codex', 'config.toml'),
        });

        const raw = await fs.readFile(claudeSettingsPath(), 'utf-8');
        expect(raw).not.toContain('kodus decisions ');

        const commands = await readClaudeCommands();
        expect(
            commands.filter(
                (entry) =>
                    entry.event === 'PostToolUse' &&
                    (entry.matcher === 'Write' || entry.matcher === 'Edit'),
            ),
        ).toHaveLength(0);
    });

    it('preserves hooks the user wrote themselves', async () => {
        await fs.mkdir(path.dirname(claudeSettingsPath()), {
            recursive: true,
        });
        await fs.writeFile(
            claudeSettingsPath(),
            JSON.stringify({
                hooks: {
                    Stop: [
                        {
                            matcher: '',
                            hooks: [
                                { type: 'command', command: 'my-own-script' },
                                {
                                    type: 'command',
                                    command:
                                        'kodus decisions hooks claude-code stop',
                                },
                            ],
                        },
                    ],
                },
            }),
        );

        await enableAction({
            agents: 'claude',
            codexConfig: path.join(tmpDir, '.codex', 'config.toml'),
        });

        const commands = await readClaudeCommands();
        expect(commands.map((entry) => entry.command)).toContain(
            'my-own-script',
        );
    });

    it('removes the legacy Codex notify line and does not reinstall it', async () => {
        const codexConfig = path.join(tmpDir, '.codex', 'config.toml');
        await fs.mkdir(path.dirname(codexConfig), { recursive: true });
        await fs.writeFile(
            codexConfig,
            `model = "gpt-5"\n${CODEX_NOTIFY_LINE_LEGACY_VARIANTS[0]}\n`,
            'utf-8',
        );

        await enableAction({ agents: 'codex', codexConfig });

        const content = await fs.readFile(codexConfig, 'utf-8');
        expect(content).not.toContain('notify =');
        expect(content).toContain('model = "gpt-5"');
        expect(content).toContain('kodus trace hooks codex AfterAgent');
    });

    it('is idempotent (second run reports already configured)', async () => {
        const codexConfig = path.join(tmpDir, '.codex', 'config.toml');

        await enableAction({ codexConfig });
        await enableAction({ codexConfig });

        const calls = vi.mocked(console.log).mock.calls.flat().join('\n');
        expect(calls).toContain('already configured');
    });

    it('--agents claude skips codex', async () => {
        await enableAction({
            agents: 'claude',
            codexConfig: path.join(tmpDir, '.codex', 'config.toml'),
        });

        const calls = vi.mocked(console.log).mock.calls.flat().join('\n');
        expect(calls).toContain('Codex session hooks: skipped');

        await expect(
            fs.access(path.join(tmpDir, '.codex', 'config.toml')),
        ).rejects.toThrow();
    });

    it('writes nothing into the repository beyond agent config files', async () => {
        await enableAction({
            agents: 'claude',
            codexConfig: path.join(tmpDir, '.codex', 'config.toml'),
        });

        const entries = await fs.readdir(tmpDir);
        expect(entries.sort()).toEqual(['.claude', '.git']);
    });
});
