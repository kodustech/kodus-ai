import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SUPPORTED_AGENTS = new Set(['claude', 'cursor', 'codex']);

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

export async function readJsonObject(filePath: string): Promise<JsonObject> {
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

export function ensureObject(root: JsonObject, key: string): JsonObject {
    const existing = root[key];
    if (isRecord(existing)) {
        return existing;
    }

    const next: JsonObject = {};
    root[key] = next;
    return next;
}

export function isRecord(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Detect whether hooks for an agent appear to be installed.
 */
export async function detectHookInstallStatus(
    repoRoot: string,
    codexConfigPath?: string,
): Promise<{
    claude: boolean;
    cursor: boolean;
    codex: boolean;
}> {
    let claude = false;
    let cursor = false;
    let codex = false;

    try {
        const settings = await readJsonObject(
            path.join(repoRoot, '.claude', 'settings.json'),
        );
        const hooks = settings.hooks;
        if (isRecord(hooks)) {
            claude = JSON.stringify(hooks).includes('kodus trace hooks');
        }
    } catch {
        // leave false
    }

    try {
        const settings = await readJsonObject(
            path.join(repoRoot, '.cursor', 'hooks.json'),
        );
        const hooks = settings.hooks;
        if (isRecord(hooks)) {
            cursor = JSON.stringify(hooks).includes('kodus trace hooks');
        }
    } catch {
        // leave false
    }

    try {
        const configPath =
            codexConfigPath ?? path.join(os.homedir(), '.codex', 'config.toml');
        const content = await fs.readFile(configPath, 'utf-8');
        codex = content.includes('kodus trace hooks codex');
    } catch {
        // leave false
    }

    return { claude, cursor, codex };
}
