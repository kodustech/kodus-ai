import fs from 'fs/promises';
import path from 'path';

const SESSIONS_HOOK_PREFIX = 'kodus decisions hooks';

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSessionsHookCommand(command: string): boolean {
    return command.includes(SESSIONS_HOOK_PREFIX);
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
            (h) => isRecord(h) && h.type === 'command' && h.command === command,
        );
        if (alreadyExists) {
            return false;
        }

        // Replace existing sessions hook command if present
        for (const hookValue of hooksArray) {
            if (
                !isRecord(hookValue) ||
                hookValue.type !== 'command' ||
                typeof hookValue.command !== 'string'
            ) {
                continue;
            }
            if (isSessionsHookCommand(hookValue.command)) {
                hookValue.command = command;
                return true;
            }
        }

        hooksArray.push({ type: 'command', command });
        return true;
    }

    matchers.push({
        matcher: matcherName,
        hooks: [{ type: 'command', command }],
    });
    return true;
}

export async function installSessionHooks(
    repoRoot: string,
    agentName: string,
): Promise<{ settingsPath: string; changed: boolean }> {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    const settings = await readJsonObject(settingsPath);
    const hooks = ensureObject(settings, 'hooks');

    const cmd = (hookEvent: string) =>
        `${SESSIONS_HOOK_PREFIX} ${agentName} ${hookEvent}`;

    let changed = false;
    changed =
        upsertHook(hooks, 'SessionStart', '', cmd('session-start')) || changed;
    changed =
        upsertHook(hooks, 'SessionEnd', '', cmd('session-end')) || changed;
    changed = upsertHook(hooks, 'Stop', '', cmd('stop')) || changed;
    changed =
        upsertHook(hooks, 'UserPromptSubmit', '', cmd('user-prompt-submit')) ||
        changed;
    changed =
        upsertHook(hooks, 'SubagentStart', '', cmd('subagent-start')) ||
        changed;
    changed =
        upsertHook(hooks, 'SubagentStop', '', cmd('subagent-stop')) || changed;
    changed =
        upsertHook(hooks, 'PostToolUse', 'TodoWrite', cmd('post-todo')) ||
        changed;

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

export async function removeSessionHooks(
    repoRoot: string,
): Promise<{ settingsPath: string; removed: boolean }> {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');

    let settings: JsonObject;
    try {
        const content = await fs.readFile(settingsPath, 'utf-8');
        const parsed = JSON.parse(content) as unknown;
        if (!isRecord(parsed)) {
            return { settingsPath, removed: false };
        }
        settings = parsed;
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
                    !isSessionsHookCommand(h.command)
                );
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

    if (Object.keys(hooks).length === 0) {
        delete settings.hooks;
    }

    if (removed) {
        if (Object.keys(settings).length === 0) {
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
