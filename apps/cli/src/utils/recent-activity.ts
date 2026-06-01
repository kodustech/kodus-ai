import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const KODUS_DIR = path.join(os.homedir(), '.kodus');
const RECENT_ACTIVITY_FILE = path.join(KODUS_DIR, 'recent-activity.json');
const MAX_ENTRIES = 10;

const SENSITIVE_FLAGS = new Set([
    '--key',
    '--team-key',
    '--token',
    '--access-token',
    '--refresh-token',
    '--password',
]);

interface RecentActivityStore {
    entries: RecentActivityEntry[];
}

export interface RecentActivityEntry {
    command: string;
    timestamp: number;
}

function isJsonParseError(error: unknown): boolean {
    return error instanceof SyntaxError;
}

async function ensureConfigDir(): Promise<void> {
    try {
        await fs.mkdir(KODUS_DIR, { recursive: true, mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
    }
}

function sanitizeArgs(args: string[]): string[] {
    const sanitized: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i] ?? '';

        if (arg.startsWith('--')) {
            const [flag, value] = arg.split('=', 2);
            if (SENSITIVE_FLAGS.has(flag)) {
                if (value !== undefined) {
                    sanitized.push(`${flag}=[REDACTED]`);
                } else {
                    sanitized.push(flag);
                    if (i + 1 < args.length) {
                        sanitized.push('[REDACTED]');
                        i += 1;
                    }
                }
                continue;
            }
        }

        sanitized.push(arg);
    }

    return sanitized;
}

function shouldRecordCommand(args: string[]): boolean {
    if (args.length === 0) {
        return false;
    }

    const firstArg = args[0];
    if (!firstArg) {
        return false;
    }

    if (
        firstArg === '--help' ||
        firstArg === '-h' ||
        firstArg === '--version' ||
        firstArg === '-V'
    ) {
        return false;
    }

    return true;
}

export async function loadRecentActivity(): Promise<RecentActivityEntry[]> {
    try {
        const content = await fs.readFile(RECENT_ACTIVITY_FILE, 'utf-8');
        const parsed = JSON.parse(content) as RecentActivityStore;

        if (!parsed || !Array.isArray(parsed.entries)) {
            return [];
        }

        return parsed.entries
            .filter(
                (entry) =>
                    entry &&
                    typeof entry.command === 'string' &&
                    typeof entry.timestamp === 'number',
            )
            .sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            return [];
        }

        if (isJsonParseError(error)) {
            const brokenFile = `${RECENT_ACTIVITY_FILE}.corrupted.${Date.now()}`;
            await fs.rename(RECENT_ACTIVITY_FILE, brokenFile).catch(() => {});
            return [];
        }

        throw error;
    }
}

export async function recordRecentActivity(rawArgs: string[]): Promise<void> {
    if (!shouldRecordCommand(rawArgs)) {
        return;
    }

    const args = sanitizeArgs(rawArgs);
    const command = `kodus ${args.join(' ').trim()}`.trim();
    if (!command || command === 'kodus') {
        return;
    }

    const existing = await loadRecentActivity();
    const nextEntries: RecentActivityEntry[] = [
        { command, timestamp: Date.now() },
        ...existing.filter((entry) => entry.command !== command),
    ].slice(0, MAX_ENTRIES);

    await ensureConfigDir();
    const tmpFile = `${RECENT_ACTIVITY_FILE}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify({ entries: nextEntries }, null, 2);
    await fs.writeFile(tmpFile, payload, { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmpFile, RECENT_ACTIVITY_FILE);
}

export function formatRelativeTime(
    timestamp: number,
    now = Date.now(),
): string {
    const diffSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
    if (diffSeconds < 60) {
        return `${diffSeconds}s ago`;
    }

    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) {
        return `${diffMinutes}m ago`;
    }

    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
        return `${diffHours}h ago`;
    }

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
}

export async function getRecentActivityLines(maxItems = 2): Promise<string[]> {
    const entries = await loadRecentActivity();
    if (entries.length === 0) {
        return ['No recent activity yet'];
    }

    return entries
        .slice(0, Math.max(1, maxItems))
        .map(
            (entry) =>
                `${entry.command} - ${formatRelativeTime(entry.timestamp)}`,
        );
}
