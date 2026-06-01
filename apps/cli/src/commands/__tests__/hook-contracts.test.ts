import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
    installSessionHooks,
    removeSessionHooks,
} from '../memory/session-hooks-install.js';
import {
    installCursorSessionHooks,
    removeCursorSessionHooks,
} from '../memory/session-hooks-install-cursor.js';
import {
    installCodexSessionHooks,
    removeCodexSessionHooks,
} from '../memory/session-hooks-install-codex.js';

let tmpDir: string;

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'kodus-hook-contracts-'),
    );
});

afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function claudeSettingsPath(): string {
    return path.join(tmpDir, '.claude', 'settings.json');
}

function cursorHooksPath(): string {
    return path.join(tmpDir, '.cursor', 'hooks.json');
}

function codexConfigPath(): string {
    return path.join(tmpDir, 'config.toml');
}

/**
 * Minimal TOML [[hooks]] block parser.
 * Returns an array of { event: string; command: string } entries.
 */
function parseTomlHookBlocks(
    content: string,
): Array<{ event: string; command: string }> {
    const blocks: Array<{ event: string; command: string }> = [];
    const lines = content.split('\n');

    let inBlock = false;
    let currentEvent = '';
    let currentCommand = '';

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '[[hooks]]') {
            if (inBlock && (currentEvent || currentCommand)) {
                blocks.push({ event: currentEvent, command: currentCommand });
            }
            inBlock = true;
            currentEvent = '';
            currentCommand = '';
            continue;
        }

        if (
            inBlock &&
            (trimmed.startsWith('[[') || trimmed.startsWith('['))
        ) {
            blocks.push({ event: currentEvent, command: currentCommand });
            inBlock = false;
            currentEvent = '';
            currentCommand = '';
            continue;
        }

        if (inBlock) {
            const eventMatch = trimmed.match(/^event\s*=\s*"(.+)"$/);
            if (eventMatch) {
                currentEvent = eventMatch[1];
            }
            const commandMatch = trimmed.match(/^command\s*=\s*"(.+)"$/);
            if (commandMatch) {
                currentCommand = commandMatch[1];
            }
        }
    }

    // Flush last block
    if (inBlock && (currentEvent || currentCommand)) {
        blocks.push({ event: currentEvent, command: currentCommand });
    }

    return blocks;
}

// ---------------------------------------------------------------------------
// Claude Code contract — .claude/settings.json
// ---------------------------------------------------------------------------

describe('Claude Code hook contract', () => {
    const VALID_CLAUDE_EVENTS = [
        'PreToolUse',
        'PostToolUse',
        'SessionStart',
        'SessionEnd',
        'Stop',
        'UserPromptSubmit',
        'SubagentStart',
        'SubagentStop',
        'Notification',
    ];

    const EXPECTED_CLAUDE_EVENTS = [
        'SessionStart',
        'SessionEnd',
        'Stop',
        'UserPromptSubmit',
        'SubagentStart',
        'SubagentStop',
        'PostToolUse',
    ];

    it('generates valid JSON', async () => {
        await installSessionHooks(tmpDir, 'claude-code');
        const raw = await fs.readFile(claudeSettingsPath(), 'utf-8');

        expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('root has a hooks object', async () => {
        await installSessionHooks(tmpDir, 'claude-code');
        const raw = await fs.readFile(claudeSettingsPath(), 'utf-8');
        const settings = JSON.parse(raw);

        expect(typeof settings.hooks).toBe('object');
        expect(settings.hooks).not.toBeNull();
        expect(Array.isArray(settings.hooks)).toBe(false);
    });

    it('all hook event keys are valid Claude Code event names', async () => {
        await installSessionHooks(tmpDir, 'claude-code');
        const raw = await fs.readFile(claudeSettingsPath(), 'utf-8');
        const settings = JSON.parse(raw);
        const hooks = settings.hooks as Record<string, unknown>;

        for (const eventKey of Object.keys(hooks)) {
            expect(
                VALID_CLAUDE_EVENTS,
                `Unexpected event key "${eventKey}"`,
            ).toContain(eventKey);
        }
    });

    it('all 7 expected events are present', async () => {
        await installSessionHooks(tmpDir, 'claude-code');
        const raw = await fs.readFile(claudeSettingsPath(), 'utf-8');
        const settings = JSON.parse(raw);
        const hooks = settings.hooks as Record<string, unknown>;

        for (const eventKey of EXPECTED_CLAUDE_EVENTS) {
            expect(hooks[eventKey], `Missing event "${eventKey}"`).toBeDefined();
        }
    });

    it('each event value is an array of matcher objects with correct shape', async () => {
        await installSessionHooks(tmpDir, 'claude-code');
        const raw = await fs.readFile(claudeSettingsPath(), 'utf-8');
        const settings = JSON.parse(raw);
        const hooks = settings.hooks as Record<string, unknown[]>;

        for (const [eventKey, matchers] of Object.entries(hooks)) {
            expect(
                Array.isArray(matchers),
                `hooks["${eventKey}"] must be an array`,
            ).toBe(true);

            for (const matcher of matchers) {
                // matcher must be an object with { matcher: string, hooks: array }
                expect(matcher).toHaveProperty('matcher');
                expect(typeof (matcher as any).matcher).toBe('string');

                expect(matcher).toHaveProperty('hooks');
                expect(Array.isArray((matcher as any).hooks)).toBe(true);

                // Each hook entry must have { type: "command", command: string }
                for (const hookEntry of (matcher as any).hooks) {
                    expect(hookEntry).toHaveProperty('type');
                    expect(hookEntry.type).toBe('command');
                    expect(hookEntry).toHaveProperty('command');
                    expect(typeof hookEntry.command).toBe('string');
                }
            }
        }
    });

    it('all commands start with "kodus decisions hooks claude-code"', async () => {
        await installSessionHooks(tmpDir, 'claude-code');
        const raw = await fs.readFile(claudeSettingsPath(), 'utf-8');
        const settings = JSON.parse(raw);
        const hooks = settings.hooks as Record<string, unknown[]>;

        for (const [eventKey, matchers] of Object.entries(hooks)) {
            for (const matcher of matchers as any[]) {
                for (const hookEntry of matcher.hooks) {
                    expect(
                        hookEntry.command.startsWith(
                            'kodus decisions hooks claude-code',
                        ),
                        `Command in "${eventKey}" does not start with expected prefix: "${hookEntry.command}"`,
                    ).toBe(true);
                }
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Cursor contract — .cursor/hooks.json
// ---------------------------------------------------------------------------

describe('Cursor hook contract', () => {
    const VALID_CURSOR_EVENTS = [
        'sessionStart',
        'sessionEnd',
        'stop',
        'beforeSubmitPrompt',
        'subagentStart',
        'subagentStop',
    ];

    const EXPECTED_CURSOR_EVENTS = [
        'sessionStart',
        'sessionEnd',
        'stop',
        'beforeSubmitPrompt',
        'subagentStart',
        'subagentStop',
    ];

    it('generates valid JSON', async () => {
        await installCursorSessionHooks(tmpDir);
        const raw = await fs.readFile(cursorHooksPath(), 'utf-8');

        expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('root has version: 1', async () => {
        await installCursorSessionHooks(tmpDir);
        const raw = await fs.readFile(cursorHooksPath(), 'utf-8');
        const config = JSON.parse(raw);

        expect(config.version).toBe(1);
    });

    it('root has a hooks object', async () => {
        await installCursorSessionHooks(tmpDir);
        const raw = await fs.readFile(cursorHooksPath(), 'utf-8');
        const config = JSON.parse(raw);

        expect(typeof config.hooks).toBe('object');
        expect(config.hooks).not.toBeNull();
        expect(Array.isArray(config.hooks)).toBe(false);
    });

    it('all hook event keys are valid Cursor event names', async () => {
        await installCursorSessionHooks(tmpDir);
        const raw = await fs.readFile(cursorHooksPath(), 'utf-8');
        const config = JSON.parse(raw);
        const hooks = config.hooks as Record<string, unknown>;

        for (const eventKey of Object.keys(hooks)) {
            expect(
                VALID_CURSOR_EVENTS,
                `Unexpected event key "${eventKey}"`,
            ).toContain(eventKey);
        }
    });

    it('all expected events are present', async () => {
        await installCursorSessionHooks(tmpDir);
        const raw = await fs.readFile(cursorHooksPath(), 'utf-8');
        const config = JSON.parse(raw);
        const hooks = config.hooks as Record<string, unknown>;

        for (const eventKey of EXPECTED_CURSOR_EVENTS) {
            expect(hooks[eventKey], `Missing event "${eventKey}"`).toBeDefined();
        }
    });

    it('each event value is an array of hook objects with command string', async () => {
        await installCursorSessionHooks(tmpDir);
        const raw = await fs.readFile(cursorHooksPath(), 'utf-8');
        const config = JSON.parse(raw);
        const hooks = config.hooks as Record<string, unknown[]>;

        for (const [eventKey, entries] of Object.entries(hooks)) {
            expect(
                Array.isArray(entries),
                `hooks["${eventKey}"] must be an array`,
            ).toBe(true);

            for (const entry of entries) {
                expect(entry).toHaveProperty('command');
                expect(typeof (entry as any).command).toBe('string');
            }
        }
    });

    it('all commands start with "kodus decisions hooks cursor"', async () => {
        await installCursorSessionHooks(tmpDir);
        const raw = await fs.readFile(cursorHooksPath(), 'utf-8');
        const config = JSON.parse(raw);
        const hooks = config.hooks as Record<string, unknown[]>;

        for (const [eventKey, entries] of Object.entries(hooks)) {
            for (const entry of entries as any[]) {
                expect(
                    entry.command.startsWith('kodus decisions hooks cursor'),
                    `Command in "${eventKey}" does not start with expected prefix: "${entry.command}"`,
                ).toBe(true);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Codex contract — config.toml
// ---------------------------------------------------------------------------

describe('Codex hook contract', () => {
    const VALID_CODEX_EVENTS = ['AfterAgent', 'AfterToolUse'];

    it('generates valid TOML with [[hooks]] blocks', async () => {
        await installCodexSessionHooks(codexConfigPath());
        const content = await fs.readFile(codexConfigPath(), 'utf-8');

        expect(content).toContain('[[hooks]]');
        const blocks = parseTomlHookBlocks(content);
        expect(blocks.length).toBeGreaterThan(0);
    });

    it('each [[hooks]] block has event and command fields', async () => {
        await installCodexSessionHooks(codexConfigPath());
        const content = await fs.readFile(codexConfigPath(), 'utf-8');
        const blocks = parseTomlHookBlocks(content);

        for (const block of blocks) {
            expect(
                block.event,
                'Hook block missing event field',
            ).toBeTruthy();
            expect(
                block.command,
                'Hook block missing command field',
            ).toBeTruthy();
        }
    });

    it('event values are valid Codex event names', async () => {
        await installCodexSessionHooks(codexConfigPath());
        const content = await fs.readFile(codexConfigPath(), 'utf-8');
        const blocks = parseTomlHookBlocks(content);

        for (const block of blocks) {
            expect(
                VALID_CODEX_EVENTS,
                `Unexpected event "${block.event}"`,
            ).toContain(block.event);
        }
    });

    it('all commands start with "kodus decisions hooks codex"', async () => {
        await installCodexSessionHooks(codexConfigPath());
        const content = await fs.readFile(codexConfigPath(), 'utf-8');
        const blocks = parseTomlHookBlocks(content);

        for (const block of blocks) {
            expect(
                block.command.startsWith('kodus decisions hooks codex'),
                `Command does not start with expected prefix: "${block.command}"`,
            ).toBe(true);
        }
    });

    it('TOML values are properly quoted strings', async () => {
        await installCodexSessionHooks(codexConfigPath());
        const content = await fs.readFile(codexConfigPath(), 'utf-8');
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('event =') || trimmed.startsWith('command =')) {
                // Value must be a double-quoted string
                expect(
                    trimmed,
                    `TOML value not properly quoted: "${trimmed}"`,
                ).toMatch(/^\w+\s*=\s*".*"$/);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Cross-platform contracts
// ---------------------------------------------------------------------------

describe('Cross-platform hook contracts', () => {
    it('all command strings are safe shell commands (no special chars that break)', async () => {
        await installSessionHooks(tmpDir, 'claude-code');
        await installCursorSessionHooks(tmpDir);
        await installCodexSessionHooks(codexConfigPath());

        const commands: string[] = [];

        // Collect Claude Code commands
        const claudeRaw = await fs.readFile(claudeSettingsPath(), 'utf-8');
        const claudeSettings = JSON.parse(claudeRaw);
        const claudeHooks = claudeSettings.hooks as Record<string, any[]>;
        for (const matchers of Object.values(claudeHooks)) {
            for (const matcher of matchers) {
                for (const hookEntry of matcher.hooks) {
                    commands.push(hookEntry.command);
                }
            }
        }

        // Collect Cursor commands
        const cursorRaw = await fs.readFile(cursorHooksPath(), 'utf-8');
        const cursorConfig = JSON.parse(cursorRaw);
        const cursorHooks = cursorConfig.hooks as Record<string, any[]>;
        for (const entries of Object.values(cursorHooks)) {
            for (const entry of entries) {
                commands.push(entry.command);
            }
        }

        // Collect Codex commands
        const codexContent = await fs.readFile(codexConfigPath(), 'utf-8');
        const codexBlocks = parseTomlHookBlocks(codexContent);
        for (const block of codexBlocks) {
            commands.push(block.command);
        }

        // Validate each command
        // Should only contain safe shell characters: alphanumeric, spaces, hyphens
        const safeCommandPattern = /^[a-zA-Z0-9 \-_./]+$/;
        for (const cmd of commands) {
            expect(cmd.length).toBeGreaterThan(0);
            expect(
                safeCommandPattern.test(cmd),
                `Command contains unsafe characters: "${cmd}"`,
            ).toBe(true);
        }
    });

    it('all hook commands reference the kodus binary', async () => {
        await installSessionHooks(tmpDir, 'claude-code');
        await installCursorSessionHooks(tmpDir);
        await installCodexSessionHooks(codexConfigPath());

        const commands: string[] = [];

        // Claude Code
        const claudeRaw = await fs.readFile(claudeSettingsPath(), 'utf-8');
        const claudeSettings = JSON.parse(claudeRaw);
        for (const matchers of Object.values(
            claudeSettings.hooks as Record<string, any[]>,
        )) {
            for (const matcher of matchers) {
                for (const hookEntry of matcher.hooks) {
                    commands.push(hookEntry.command);
                }
            }
        }

        // Cursor
        const cursorRaw = await fs.readFile(cursorHooksPath(), 'utf-8');
        const cursorConfig = JSON.parse(cursorRaw);
        for (const entries of Object.values(
            cursorConfig.hooks as Record<string, any[]>,
        )) {
            for (const entry of entries) {
                commands.push(entry.command);
            }
        }

        // Codex
        const codexContent = await fs.readFile(codexConfigPath(), 'utf-8');
        for (const block of parseTomlHookBlocks(codexContent)) {
            commands.push(block.command);
        }

        for (const cmd of commands) {
            expect(
                cmd.startsWith('kodus '),
                `Command does not reference kodus binary: "${cmd}"`,
            ).toBe(true);
        }
    });

    it('Claude Code: install then remove leaves config clean', async () => {
        await installSessionHooks(tmpDir, 'claude-code');
        await removeSessionHooks(tmpDir);

        const raw = await fs.readFile(claudeSettingsPath(), 'utf-8');
        const settings = JSON.parse(raw);

        // No hooks key should remain (all were kodus entries)
        expect(settings.hooks).toBeUndefined();

        // No kodus references anywhere in the file
        expect(raw).not.toContain('kodus decisions hooks');
    });

    it('Cursor: install then remove leaves config clean', async () => {
        await installCursorSessionHooks(tmpDir);
        await removeCursorSessionHooks(tmpDir);

        const raw = await fs.readFile(cursorHooksPath(), 'utf-8');
        const config = JSON.parse(raw);

        // hooks should be empty
        expect(Object.keys(config.hooks)).toHaveLength(0);

        // No kodus references anywhere in the file
        expect(raw).not.toContain('kodus decisions hooks');
    });

    it('Codex: install then remove leaves config clean', async () => {
        await installCodexSessionHooks(codexConfigPath());
        await removeCodexSessionHooks(codexConfigPath());

        const content = await fs.readFile(codexConfigPath(), 'utf-8');

        // No kodus references
        expect(content).not.toContain('kodus decisions hooks');

        // No leftover [[hooks]] blocks (only kodus block was present)
        expect(content).not.toContain('[[hooks]]');
    });
});
