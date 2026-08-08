import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SUPPORTED_AGENTS = new Set(['claude', 'cursor', 'codex']);

/**
 * Everything the previous release wrote into a user's own config. These strings
 * are dead: the command name changed and the duplicate capture pipeline behind
 * `kodus decisions capture` is gone. Left in place they would fire forever
 * against commands that no longer exist, and the failure would be swallowed.
 */
export const LEGACY_DECISIONS_COMMAND_PREFIX = 'kodus decisions ';

export const TRACE_HOOK_COMMAND_PREFIX = 'kodus trace hooks';

export const CODEX_NOTIFY_LINE_LEGACY_VARIANTS = [
    'notify = ["kodus", "decisions", "capture", "--capture-agent", "codex", "--event", "stop"]',
    'notify = ["kodus", "decisions", "capture", "--agent", "codex", "--event", "stop"]',
    'notify = ["kodus", "decisions", "capture", "--agent", "codex", "--event", "agent-turn-complete"]',
];

type JsonObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

function isRecord(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isLegacyDecisionsCommand(command: string): boolean {
    return command.trimStart().startsWith(LEGACY_DECISIONS_COMMAND_PREFIX);
}

export function isKodusTraceHookCommand(command: string): boolean {
    return command.includes(TRACE_HOOK_COMMAND_PREFIX);
}

function isManagedByKodus(command: string): boolean {
    return (
        isLegacyDecisionsCommand(command) || isKodusTraceHookCommand(command)
    );
}

// ---------------------------------------------------------------------------
// Claude-compatible settings.json (Claude Code, and Cursor's Claude bridge)
// ---------------------------------------------------------------------------

/**
 * Strip every hook this CLI has ever installed from a Claude-compatible
 * settings file, including hooks for events this work no longer installs.
 *
 * Called from both `trace enable` (before installing) and `trace disable`.
 */
export async function removeClaudeCompatibleHooks(
    repoRoot: string,
    predicate: (command: string) => boolean = isManagedByKodus,
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
            matcher.hooks = (matcher.hooks as unknown[]).filter((entry) => {
                if (!isRecord(entry)) {
                    return true;
                }
                return (
                    typeof entry.command !== 'string' ||
                    !predicate(entry.command)
                );
            });

            if ((matcher.hooks as unknown[]).length < originalLength) {
                removed = true;
            }
        }

        hooks[eventKey] = matchers.filter((matcher) => {
            if (!isRecord(matcher)) {
                return true;
            }
            return Array.isArray(matcher.hooks) && matcher.hooks.length > 0;
        });

        if ((hooks[eventKey] as unknown[]).length === 0) {
            delete hooks[eventKey];
        }
    }

    if (Object.keys(hooks).length === 0) {
        delete settings.hooks;
    }

    if (removed) {
        await fs.writeFile(
            settingsPath,
            Object.keys(settings).length === 0
                ? '{}\n'
                : `${JSON.stringify(settings, null, 2)}\n`,
            'utf-8',
        );
    }

    return { settingsPath, removed };
}

/**
 * Same cleanup for Cursor's native `.cursor/hooks.json`, which the previous
 * release also wrote `kodus decisions` commands into.
 */
export async function removeCursorLegacyHooks(
    repoRoot: string,
): Promise<{ settingsPath: string; removed: boolean }> {
    const settingsPath = path.join(repoRoot, '.cursor', 'hooks.json');

    let config: JsonObject;
    try {
        config = await readJsonObject(settingsPath);
    } catch {
        return { settingsPath, removed: false };
    }

    const hooks = config.hooks;
    if (!isRecord(hooks)) {
        return { settingsPath, removed: false };
    }

    let removed = false;

    for (const eventKey of Object.keys(hooks)) {
        const entries = hooks[eventKey];
        if (!Array.isArray(entries)) {
            continue;
        }

        const filtered = entries.filter(
            (entry) =>
                !isRecord(entry) ||
                typeof entry.command !== 'string' ||
                !isLegacyDecisionsCommand(entry.command),
        );

        if (filtered.length < entries.length) {
            removed = true;
        }

        if (filtered.length === 0) {
            delete hooks[eventKey];
        } else {
            hooks[eventKey] = filtered;
        }
    }

    if (removed) {
        await fs.writeFile(
            settingsPath,
            `${JSON.stringify(config, null, 2)}\n`,
            'utf-8',
        );
    }

    return { settingsPath, removed };
}

// ---------------------------------------------------------------------------
// Codex `notify` — legacy only. The lifecycle path uses [[hooks]] instead.
// ---------------------------------------------------------------------------

export async function removeCodexNotify(
    configPath: string,
): Promise<{ configPath: string; removed: boolean }> {
    let content: string;
    try {
        content = await fs.readFile(configPath, 'utf-8');
    } catch {
        return { configPath, removed: false };
    }

    const hasLegacy = CODEX_NOTIFY_LINE_LEGACY_VARIANTS.some((line) =>
        content.includes(line),
    );
    const hasGenericKodusNotify = /^notify\s*=\s*\[\s*"kodus"/m.test(content);

    if (!hasLegacy && !hasGenericKodusNotify) {
        return { configPath, removed: false };
    }

    const nextContent = content
        .split('\n')
        .filter((line) => {
            const trimmed = line.trim();
            if (CODEX_NOTIFY_LINE_LEGACY_VARIANTS.includes(trimmed)) {
                return false;
            }
            return !/^notify\s*=\s*\[\s*"kodus"/.test(trimmed);
        })
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
