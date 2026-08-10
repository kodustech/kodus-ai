import fs from 'fs/promises';
import path from 'path';

const SESSIONS_HOOK_PREFIX = 'kodus trace hooks cursor';

type JsonObject = Record<string, unknown>;

interface CursorHookEntry {
    command: string;
    [key: string]: unknown;
}

interface CursorHooksConfig {
    version: number;
    hooks: Record<string, CursorHookEntry[]>;
}

function isRecord(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSessionsHookCommand(command: string): boolean {
    return (
        command.includes('kodus trace hooks') ||
        command.trimStart().startsWith('kodus decisions ')
    );
}

async function readCursorHooksConfig(
    filePath: string,
): Promise<CursorHooksConfig> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content) as unknown;
        if (!isRecord(parsed)) {
            return { version: 1, hooks: {} };
        }
        const rawHooks = isRecord(parsed.hooks) ? parsed.hooks : {};
        // Validate that each hook value is an array of objects with `command`
        const hooks: Record<string, CursorHookEntry[]> = {};
        for (const [key, value] of Object.entries(rawHooks)) {
            if (Array.isArray(value)) {
                hooks[key] = value.filter(
                    (e) => isRecord(e) && typeof e.command === 'string',
                ) as CursorHookEntry[];
            }
        }
        return {
            version: typeof parsed.version === 'number' ? parsed.version : 1,
            hooks,
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { version: 1, hooks: {} };
        }
        // Malformed JSON — start fresh rather than crashing
        if (error instanceof SyntaxError) {
            return { version: 1, hooks: {} };
        }
        throw error;
    }
}

function upsertHook(
    hooks: Record<string, CursorHookEntry[]>,
    eventName: string,
    command: string,
): boolean {
    const entries = hooks[eventName] ?? [];
    hooks[eventName] = entries;

    const managed = entries.filter((entry) =>
        isSessionsHookCommand(entry.command),
    );
    if (managed.length === 1 && managed[0].command === command) {
        return false;
    }
    hooks[eventName] = [
        ...entries.filter((entry) => !isSessionsHookCommand(entry.command)),
        { command },
    ];
    return true;
}

export async function installCursorSessionHooks(
    repoRoot: string,
): Promise<{ settingsPath: string; changed: boolean }> {
    const settingsPath = path.join(repoRoot, '.cursor', 'hooks.json');
    const config = await readCursorHooksConfig(settingsPath);

    const cmd = (hookEvent: string) => `${SESSIONS_HOOK_PREFIX} ${hookEvent}`;

    let changed = false;
    changed =
        upsertHook(config.hooks, 'sessionStart', cmd('sessionStart')) ||
        changed;
    changed =
        upsertHook(config.hooks, 'sessionEnd', cmd('sessionEnd')) || changed;
    changed = upsertHook(config.hooks, 'stop', cmd('stop')) || changed;
    changed =
        upsertHook(
            config.hooks,
            'beforeSubmitPrompt',
            cmd('beforeSubmitPrompt'),
        ) || changed;
    changed =
        upsertHook(config.hooks, 'subagentStart', cmd('subagentStart')) ||
        changed;
    changed =
        upsertHook(config.hooks, 'subagentStop', cmd('subagentStop')) ||
        changed;

    if (changed) {
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.writeFile(
            settingsPath,
            `${JSON.stringify(config, null, 2)}\n`,
            'utf-8',
        );
    }

    return { settingsPath, changed };
}

export async function removeCursorSessionHooks(
    repoRoot: string,
): Promise<{ settingsPath: string; removed: boolean }> {
    const settingsPath = path.join(repoRoot, '.cursor', 'hooks.json');

    let config: CursorHooksConfig;
    try {
        config = await readCursorHooksConfig(settingsPath);
    } catch {
        return { settingsPath, removed: false };
    }

    let removed = false;

    for (const eventName of Object.keys(config.hooks)) {
        const entries = config.hooks[eventName];
        if (!Array.isArray(entries)) {
            continue;
        }

        const filtered = entries.filter(
            (e) => !isSessionsHookCommand(e.command),
        );
        if (filtered.length < entries.length) {
            removed = true;
        }

        if (filtered.length === 0) {
            delete config.hooks[eventName];
        } else {
            config.hooks[eventName] = filtered;
        }
    }

    if (removed) {
        if (Object.keys(config.hooks).length === 0) {
            await fs.writeFile(
                settingsPath,
                JSON.stringify({ version: 1, hooks: {} }, null, 2) + '\n',
                'utf-8',
            );
        } else {
            await fs.writeFile(
                settingsPath,
                `${JSON.stringify(config, null, 2)}\n`,
                'utf-8',
            );
        }
    }

    return { settingsPath, removed };
}
