import fs from 'fs/promises';
import path from 'path';

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when a hook command belongs to the legacy `kodus decisions *` group
 * (capture, hooks, enable, etc.). All of these are stripped on `trace enable`.
 */
export function isLegacyDecisionsCommand(command: string): boolean {
    return (
        command.includes('kodus decisions ') ||
        command.startsWith('kodus decisions') ||
        /["']kodus["']\s*,\s*["']decisions["']/.test(command)
    );
}

/**
 * Strip every hook whose command starts with / contains `kodus decisions `
 * from a Claude-compatible settings.json hooks object. Returns whether anything
 * was removed.
 */
export function stripLegacyDecisionsFromHooksObject(
    hooks: JsonObject,
): boolean {
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
                if (!isRecord(h) || typeof h.command !== 'string') {
                    return true;
                }
                return !isLegacyDecisionsCommand(h.command);
            });

            if ((matcher.hooks as unknown[]).length < originalLength) {
                removed = true;
            }
        }

        hooks[eventKey] = matchers.filter((m) => {
            if (!isRecord(m)) {
                return true;
            }
            return Array.isArray(m.hooks) && m.hooks.length > 0;
        });

        if ((hooks[eventKey] as unknown[]).length === 0) {
            delete hooks[eventKey];
        }
    }

    return removed;
}

/**
 * Strip legacy decisions hooks from .claude/settings.json.
 */
export async function stripLegacyClaudeSettings(
    repoRoot: string,
): Promise<boolean> {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    let settings: JsonObject;
    try {
        const content = await fs.readFile(settingsPath, 'utf-8');
        const parsed = JSON.parse(content) as unknown;
        if (!isRecord(parsed)) {
            return false;
        }
        settings = parsed;
    } catch {
        return false;
    }

    const hooks = settings.hooks;
    if (!isRecord(hooks)) {
        return false;
    }

    const removed = stripLegacyDecisionsFromHooksObject(hooks);
    if (!removed) {
        return false;
    }

    if (Object.keys(hooks).length === 0) {
        delete settings.hooks;
    }

    if (Object.keys(settings).length === 0) {
        await fs.writeFile(settingsPath, '{}\n', 'utf-8');
    } else {
        await fs.writeFile(
            settingsPath,
            `${JSON.stringify(settings, null, 2)}\n`,
            'utf-8',
        );
    }
    return true;
}

/**
 * Strip legacy decisions hooks from .cursor/hooks.json.
 */
export async function stripLegacyCursorHooks(
    repoRoot: string,
): Promise<boolean> {
    const hooksPath = path.join(repoRoot, '.cursor', 'hooks.json');
    let config: JsonObject;
    try {
        const content = await fs.readFile(hooksPath, 'utf-8');
        const parsed = JSON.parse(content) as unknown;
        if (!isRecord(parsed)) {
            return false;
        }
        config = parsed;
    } catch {
        return false;
    }

    const hooks = config.hooks;
    if (!isRecord(hooks)) {
        return false;
    }

    let removed = false;
    for (const eventName of Object.keys(hooks)) {
        const entries = hooks[eventName];
        if (!Array.isArray(entries)) {
            continue;
        }
        const filtered = entries.filter((e) => {
            if (!isRecord(e) || typeof e.command !== 'string') {
                return true;
            }
            return !isLegacyDecisionsCommand(e.command);
        });
        if (filtered.length < entries.length) {
            removed = true;
        }
        if (filtered.length === 0) {
            delete hooks[eventName];
        } else {
            hooks[eventName] = filtered;
        }
    }

    if (!removed) {
        return false;
    }

    await fs.writeFile(
        hooksPath,
        `${JSON.stringify(config, null, 2)}\n`,
        'utf-8',
    );
    return true;
}

/**
 * Strip legacy `kodus decisions` lines / notify entries from a Codex config.
 */
export async function stripLegacyCodexConfig(
    configPath: string,
): Promise<boolean> {
    let content: string;
    try {
        content = await fs.readFile(configPath, 'utf-8');
    } catch {
        return false;
    }

    if (!content.includes('decisions')) {
        return false;
    }

    const lines = content.split('\n');
    const result: string[] = [];
    let i = 0;
    let removed = false;

    while (i < lines.length) {
        const line = lines[i];

        // Drop notify lines that reference decisions capture
        if (/^\s*notify\s*=/.test(line) && line.includes('decisions')) {
            removed = true;
            i += 1;
            continue;
        }

        // Drop [[hooks]] blocks that reference decisions
        if (line.trim() === '[[hooks]]') {
            const block: string[] = [line];
            i += 1;
            while (i < lines.length && !lines[i].trim().startsWith('[[')) {
                block.push(lines[i]);
                i += 1;
            }
            if (block.some((l) => l.includes('kodus decisions'))) {
                removed = true;
                continue;
            }
            result.push(...block);
            continue;
        }

        result.push(line);
        i += 1;
    }

    if (!removed) {
        return false;
    }

    await fs.writeFile(
        configPath,
        result.join('\n').replace(/\n{3,}/g, '\n\n'),
        'utf-8',
    );
    return true;
}
