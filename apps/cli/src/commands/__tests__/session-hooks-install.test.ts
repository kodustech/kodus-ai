import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
    installSessionHooks,
    removeSessionHooks,
} from '../memory/session-hooks-install.js';

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-session-hooks-'));
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

function settingsPath(): string {
    return path.join(tmpDir, '.claude', 'settings.json');
}

async function readSettings(): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(settingsPath(), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
}

describe('installSessionHooks', () => {
    it('creates settings.json with all hook events', async () => {
        const result = await installSessionHooks(tmpDir, 'claude-code');

        expect(result.changed).toBe(true);
        expect(result.settingsPath).toBe(settingsPath());

        const settings = await readSettings();
        const hooks = settings.hooks as Record<string, unknown>;

        expect(hooks).toBeDefined();
        expect(hooks['SessionStart']).toBeDefined();
        expect(hooks['SessionEnd']).toBeDefined();
        expect(hooks['Stop']).toBeDefined();
        expect(hooks['UserPromptSubmit']).toBeDefined();
        expect(hooks['SubagentStart']).toBeDefined();
        expect(hooks['SubagentStop']).toBeDefined();
        expect(hooks['PostToolUse']).toBeDefined();
    });

    it('sets correct commands for each hook event', async () => {
        await installSessionHooks(tmpDir, 'claude-code');

        const settings = await readSettings();
        const hooks = settings.hooks as Record<string, unknown[]>;

        const getCommand = (eventKey: string): string => {
            const matchers = hooks[eventKey] as Array<{
                hooks: Array<{ command: string }>;
            }>;
            return matchers[0].hooks[0].command;
        };

        expect(getCommand('SessionStart')).toBe(
            'kodus decisions hooks claude-code session-start',
        );
        expect(getCommand('SessionEnd')).toBe(
            'kodus decisions hooks claude-code session-end',
        );
        expect(getCommand('Stop')).toBe(
            'kodus decisions hooks claude-code stop',
        );
        expect(getCommand('UserPromptSubmit')).toBe(
            'kodus decisions hooks claude-code user-prompt-submit',
        );
    });

    it('uses native SubagentStart/SubagentStop and PostToolUse(TodoWrite)', async () => {
        await installSessionHooks(tmpDir, 'claude-code');

        const settings = await readSettings();
        const hooks = settings.hooks as Record<string, unknown[]>;

        // Native subagent hooks (no matcher needed)
        const subagentStart = hooks['SubagentStart'] as Array<{
            matcher: string;
            hooks: Array<{ command: string }>;
        }>;
        const subagentStop = hooks['SubagentStop'] as Array<{
            matcher: string;
            hooks: Array<{ command: string }>;
        }>;
        expect(subagentStart[0].hooks[0].command).toContain('subagent-start');
        expect(subagentStop[0].hooks[0].command).toContain('subagent-stop');

        // PostToolUse(TodoWrite) still used for turn_end
        const postToolUse = hooks['PostToolUse'] as Array<{ matcher: string }>;
        expect(
            postToolUse.find((m) => m.matcher === 'TodoWrite'),
        ).toBeDefined();
    });

    it('is idempotent — second install returns changed=false', async () => {
        await installSessionHooks(tmpDir, 'claude-code');
        const result = await installSessionHooks(tmpDir, 'claude-code');

        expect(result.changed).toBe(false);
    });

    it('preserves existing settings', async () => {
        await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
        await fs.writeFile(
            settingsPath(),
            JSON.stringify({ other: 'value' }, null, 2),
        );

        await installSessionHooks(tmpDir, 'claude-code');

        const settings = await readSettings();
        expect(settings.other).toBe('value');
        expect(settings.hooks).toBeDefined();
    });

    it('works with cursor agent name', async () => {
        await installSessionHooks(tmpDir, 'cursor');

        const settings = await readSettings();
        const hooks = settings.hooks as Record<string, unknown[]>;
        const sessionStart = hooks['SessionStart'] as Array<{
            hooks: Array<{ command: string }>;
        }>;

        expect(sessionStart[0].hooks[0].command).toBe(
            'kodus decisions hooks cursor session-start',
        );
    });
});

describe('removeSessionHooks', () => {
    it('removes all kodus session hooks', async () => {
        await installSessionHooks(tmpDir, 'claude-code');
        const result = await removeSessionHooks(tmpDir);

        expect(result.removed).toBe(true);

        const settings = await readSettings();
        // hooks key should be gone (all entries were kodus)
        expect(settings.hooks).toBeUndefined();
    });

    it('returns removed=false when no settings file', async () => {
        const result = await removeSessionHooks(tmpDir);
        expect(result.removed).toBe(false);
    });

    it('returns removed=false when no kodus hooks present', async () => {
        await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
        await fs.writeFile(
            settingsPath(),
            JSON.stringify(
                {
                    hooks: {
                        SessionStart: [
                            {
                                matcher: '',
                                hooks: [
                                    { type: 'command', command: 'echo hello' },
                                ],
                            },
                        ],
                    },
                },
                null,
                2,
            ),
        );

        const result = await removeSessionHooks(tmpDir);
        expect(result.removed).toBe(false);
    });

    it('preserves non-kodus hooks', async () => {
        await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });

        // Install kodus hooks first
        await installSessionHooks(tmpDir, 'claude-code');

        // Add a non-kodus hook to SessionStart
        const settings = await readSettings();
        const hooks = settings.hooks as Record<string, unknown[]>;
        const sessionStart = hooks['SessionStart'] as Array<{
            matcher: string;
            hooks: unknown[];
        }>;
        sessionStart[0].hooks.push({
            type: 'command',
            command: 'echo custom-hook',
        });
        await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2));

        // Remove kodus hooks
        await removeSessionHooks(tmpDir);

        const after = await readSettings();
        const afterHooks = after.hooks as Record<string, unknown[]>;
        const afterSessionStart = afterHooks['SessionStart'] as Array<{
            hooks: Array<{ command: string }>;
        }>;

        // The custom hook should remain
        expect(afterSessionStart[0].hooks).toHaveLength(1);
        expect(afterSessionStart[0].hooks[0].command).toBe('echo custom-hook');
    });
});
