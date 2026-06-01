import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SUPPORTED_AGENTS = new Set(['claude', 'cursor', 'codex']);

const DECISIONS_CAPTURE_COMMAND_PREFIX = 'kodus decisions capture';

export const CLAUDE_CAPTURE_COMMANDS = {
    userPromptSubmit:
        'kodus decisions capture --capture-agent claude-compatible --event user-prompt-submit',
    stop: 'kodus decisions capture --capture-agent claude-compatible --event stop',
    postToolUseWrite:
        'kodus decisions capture --capture-agent claude-compatible --event post-tool-use-write',
    postToolUseEdit:
        'kodus decisions capture --capture-agent claude-compatible --event post-tool-use-edit',
};

export const CODEX_NOTIFY_LINE =
    'notify = ["kodus", "decisions", "capture", "--capture-agent", "codex", "--event", "stop"]';
export const CODEX_NOTIFY_LINE_STOP_LEGACY =
    'notify = ["kodus", "decisions", "capture", "--agent", "codex", "--event", "stop"]';
export const CODEX_NOTIFY_LINE_LEGACY =
    'notify = ["kodus", "decisions", "capture", "--agent", "codex", "--event", "agent-turn-complete"]';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

export function parseAgents(rawAgents: string): Set<string> {
    const aliases: Record<string, string> = {
        'claude': 'claude',
        'claude-code': 'claude',
        'cursor': 'cursor',
        'codex': 'codex',
    };

    const selected = new Set<string>();

    for (const token of rawAgents.split(',')) {
        const normalized = token.trim().toLowerCase();
        if (!normalized) {
            continue;
        }

        const mapped = aliases[normalized];
        if (!mapped || !SUPPORTED_AGENTS.has(mapped)) {
            throw new Error(
                `Unsupported agent: ${normalized}. Supported values: claude, cursor, codex`,
            );
        }

        selected.add(mapped);
    }

    return selected;
}

export function resolveCodexConfigPath(rawPath?: string): string {
    if (!rawPath) {
        return path.join(os.homedir(), '.codex', 'config.toml');
    }

    if (rawPath.startsWith('~/')) {
        return path.join(os.homedir(), rawPath.slice(2));
    }

    return path.resolve(rawPath);
}

async function readJsonObject(filePath: string): Promise<JsonObject> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content) as unknown;
        if (!isRecord(parsed)) {
            throw new Error('JSON root must be an object');
        }
        return parsed;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        throw error;
    }
}

function ensureObject(root: JsonObject, key: string): JsonObject {
    const existing = root[key];
    if (isRecord(existing)) {
        return existing;
    }

    const next: JsonObject = {};
    root[key] = next;
    return next;
}

function isRecord(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKodusCaptureCommand(command: string): boolean {
    return command.includes(DECISIONS_CAPTURE_COMMAND_PREFIX);
}

function upsertHook(
    hooks: JsonObject,
    eventKey: string,
    matcherName: string,
    command: string,
): boolean {
    const existing = hooks[eventKey];
    const matchers: unknown[] = Array.isArray(existing) ? existing : [];

    if (!Array.isArray(existing)) {
        hooks[eventKey] = matchers;
    }

    for (const matcherValue of matchers) {
        if (!isRecord(matcherValue)) {
            continue;
        }

        const currentMatcher =
            typeof matcherValue.matcher === 'string'
                ? matcherValue.matcher
                : '';
        if (currentMatcher !== matcherName) {
            continue;
        }

        const hooksArray = Array.isArray(matcherValue.hooks)
            ? matcherValue.hooks
            : [];
        if (!Array.isArray(matcherValue.hooks)) {
            matcherValue.hooks = hooksArray;
        }

        const alreadyExists = hooksArray.some(
            (hookValue) =>
                isRecord(hookValue) &&
                hookValue.type === 'command' &&
                hookValue.command === command,
        );
        if (alreadyExists) {
            return false;
        }

        for (const hookValue of hooksArray) {
            if (
                !isRecord(hookValue) ||
                hookValue.type !== 'command' ||
                typeof hookValue.command !== 'string'
            ) {
                continue;
            }

            if (isKodusCaptureCommand(hookValue.command)) {
                hookValue.command = command;
                return true;
            }
        }

        hooksArray.push({ type: 'command', command });
        return true;
    }

    matchers.push({
        matcher: matcherName,
        hooks: [
            {
                type: 'command',
                command,
            },
        ],
    });

    return true;
}

// ---------------------------------------------------------------------------
// Install functions
// ---------------------------------------------------------------------------

export async function installClaudeCompatibleHooks(
    repoRoot: string,
): Promise<{ settingsPath: string; changed: boolean }> {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    const settings = await readJsonObject(settingsPath);

    const hooks = ensureObject(settings, 'hooks');

    let changed = false;
    changed =
        upsertHook(
            hooks,
            'UserPromptSubmit',
            '',
            CLAUDE_CAPTURE_COMMANDS.userPromptSubmit,
        ) || changed;
    changed =
        upsertHook(hooks, 'Stop', '', CLAUDE_CAPTURE_COMMANDS.stop) || changed;
    changed =
        upsertHook(
            hooks,
            'PostToolUse',
            'Write',
            CLAUDE_CAPTURE_COMMANDS.postToolUseWrite,
        ) || changed;
    changed =
        upsertHook(
            hooks,
            'PostToolUse',
            'Edit',
            CLAUDE_CAPTURE_COMMANDS.postToolUseEdit,
        ) || changed;

    if (changed) {
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.writeFile(
            settingsPath,
            `${JSON.stringify(settings, null, 2)}\n`,
            'utf-8',
        );
    }

    return { settingsPath, changed };
}

export async function installCodexNotify(configPath: string): Promise<{
    configPath: string;
    changed: boolean;
    skipped: boolean;
    reason: string;
}> {
    let content = '';

    try {
        content = await fs.readFile(configPath, 'utf-8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }

    const notifyLinePattern = /^notify\s*=\s*\[(?:[^\n]*)\]\s*$/m;

    if (content.includes(CODEX_NOTIFY_LINE)) {
        return { configPath, changed: false, skipped: false, reason: '' };
    }

    if (content.includes(CODEX_NOTIFY_LINE_LEGACY)) {
        const nextContent = content.replace(
            CODEX_NOTIFY_LINE_LEGACY,
            CODEX_NOTIFY_LINE,
        );
        await fs.writeFile(configPath, nextContent, 'utf-8');
        return { configPath, changed: true, skipped: false, reason: '' };
    }

    if (content.includes(CODEX_NOTIFY_LINE_STOP_LEGACY)) {
        const nextContent = content.replace(
            CODEX_NOTIFY_LINE_STOP_LEGACY,
            CODEX_NOTIFY_LINE,
        );
        await fs.writeFile(configPath, nextContent, 'utf-8');
        return { configPath, changed: true, skipped: false, reason: '' };
    }

    if (notifyLinePattern.test(content)) {
        return {
            configPath,
            changed: false,
            skipped: true,
            reason: 'Existing `notify` entry found. Merge manually if you want Kodus decision capture.',
        };
    }

    const nextContent =
        content.trim().length === 0
            ? `${CODEX_NOTIFY_LINE}\n`
            : `${content.replace(/\s*$/, '')}\n${CODEX_NOTIFY_LINE}\n`;

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, nextContent, 'utf-8');

    return { configPath, changed: true, skipped: false, reason: '' };
}

// ---------------------------------------------------------------------------
// Remove functions (for disable)
// ---------------------------------------------------------------------------

export async function removeClaudeCompatibleHooks(
    repoRoot: string,
): Promise<{ settingsPath: string; removed: boolean }> {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');

    let settings: JsonObject;
    try {
        settings = await readJsonObject(settingsPath);
    } catch {
        return { settingsPath, removed: false };
    }

    const hooks = settings.hooks;
    if (!isRecord(hooks)) {
        return { settingsPath, removed: false };
    }

    let removed = false;

    for (const eventKey of Object.keys(hooks)) {
        const matchers = hooks[eventKey];
        if (!Array.isArray(matchers)) {
            continue;
        }

        for (const matcher of matchers) {
            if (!isRecord(matcher) || !Array.isArray(matcher.hooks)) {
                continue;
            }

            const originalLength = matcher.hooks.length;
            matcher.hooks = (matcher.hooks as unknown[]).filter((h) => {
                if (!isRecord(h)) {
                    return true;
                }
                return (
                    typeof h.command !== 'string' ||
                    !isKodusCaptureCommand(h.command)
                );
            });

            if ((matcher.hooks as unknown[]).length < originalLength) {
                removed = true;
            }
        }

        // Remove matchers with empty hooks arrays
        hooks[eventKey] = matchers.filter((m) => {
            if (!isRecord(m)) {
                return true;
            }
            return Array.isArray(m.hooks) && m.hooks.length > 0;
        });

        // Remove event key if no matchers left
        if ((hooks[eventKey] as unknown[]).length === 0) {
            delete hooks[eventKey];
        }
    }

    // Remove hooks key if empty
    if (Object.keys(hooks).length === 0) {
        delete settings.hooks;
    }

    if (removed) {
        if (Object.keys(settings).length === 0) {
            // If settings is now empty, write empty object
            await fs.writeFile(settingsPath, '{}\n', 'utf-8');
        } else {
            await fs.writeFile(
                settingsPath,
                `${JSON.stringify(settings, null, 2)}\n`,
                'utf-8',
            );
        }
    }

    return { settingsPath, removed };
}

export async function removeCodexNotify(
    configPath: string,
): Promise<{ configPath: string; removed: boolean }> {
    let content: string;
    try {
        content = await fs.readFile(configPath, 'utf-8');
    } catch {
        return { configPath, removed: false };
    }

    if (
        !content.includes(CODEX_NOTIFY_LINE) &&
        !content.includes(CODEX_NOTIFY_LINE_STOP_LEGACY) &&
        !content.includes(CODEX_NOTIFY_LINE_LEGACY)
    ) {
        return { configPath, removed: false };
    }

    const nextContent = content
        .split('\n')
        .filter(
            (line) =>
                line.trim() !== CODEX_NOTIFY_LINE &&
                line.trim() !== CODEX_NOTIFY_LINE_STOP_LEGACY &&
                line.trim() !== CODEX_NOTIFY_LINE_LEGACY,
        )
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '')
        .replace(/\n*$/, '\n');

    await fs.writeFile(
        configPath,
        nextContent === '\n' ? '' : nextContent,
        'utf-8',
    );

    return { configPath, removed: true };
}
