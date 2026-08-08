import fs from 'fs/promises';
import path from 'path';
import { ensureDir, getSessionsDir } from './kodus-paths.service.js';

/**
 * Lightweight per-session turn state used by lifecycle hooks to pair
 * turn_start / turn_end and track transcript offsets.
 *
 * Stored under ~/.kodus/sessions/<repo-hash>/_state/<sessionId>.json
 * — never inside the repository working tree.
 */

export interface LocalSessionData {
    turnId: string;
    transcriptPath: string;
    transcriptOffset: number;
    /** Set to true after turn_end is sent — prevents duplicate turn_end events */
    turnCompleted?: boolean;
}

function stateDir(sessionsDir: string): string {
    return path.join(sessionsDir, '_state');
}

function sessionPath(sessionsDir: string, sessionId: string): string {
    if (path.basename(sessionId) !== sessionId) {
        throw new Error(`Invalid sessionId: ${sessionId}`);
    }
    return path.join(stateDir(sessionsDir), `${sessionId}.json`);
}

export async function saveLocal(
    repoRoot: string,
    sessionId: string,
    data: LocalSessionData,
): Promise<void> {
    const sessionsDir = await getSessionsDir(repoRoot);
    const filePath = sessionPath(sessionsDir, sessionId);
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, JSON.stringify(data) + '\n', 'utf-8');
}

export async function loadLocal(
    repoRoot: string,
    sessionId: string,
): Promise<LocalSessionData | null> {
    const sessionsDir = await getSessionsDir(repoRoot);
    try {
        const content = await fs.readFile(
            sessionPath(sessionsDir, sessionId),
            'utf-8',
        );
        return JSON.parse(content) as LocalSessionData;
    } catch {
        return null;
    }
}

export async function removeLocal(
    repoRoot: string,
    sessionId: string,
): Promise<void> {
    const sessionsDir = await getSessionsDir(repoRoot);
    try {
        await fs.unlink(sessionPath(sessionsDir, sessionId));
    } catch {
        // Ignore if file doesn't exist
    }
}

/**
 * Mark the current turn as completed to prevent duplicate turn_end events
 * (e.g. Stop + PostToolUse(TodoWrite) both triggering TurnEnd).
 */
export async function markTurnCompleted(
    repoRoot: string,
    sessionId: string,
): Promise<void> {
    const data = await loadLocal(repoRoot, sessionId);
    if (!data) {
        return;
    }
    data.turnCompleted = true;
    const sessionsDir = await getSessionsDir(repoRoot);
    const filePath = sessionPath(sessionsDir, sessionId);
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, JSON.stringify(data) + '\n', 'utf-8');
}

export interface StaleSession {
    sessionId: string;
    ageMs: number;
}

/**
 * List turn-state files older than maxAgeMs.
 * Used on SessionStart to detect orphaned sessions from previous crashes.
 */
export async function listStaleSessions(
    repoRoot: string,
    maxAgeMs: number,
): Promise<StaleSession[]> {
    const sessionsDir = await getSessionsDir(repoRoot);
    const dir = stateDir(sessionsDir);
    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return [];
    }

    const now = Date.now();
    const jsonEntries = entries.filter((entry) => entry.endsWith('.json'));

    const results = await Promise.allSettled(
        jsonEntries.map(async (entry) => {
            const stat = await fs.stat(path.join(dir, entry));
            return { entry, mtimeMs: stat.mtimeMs };
        }),
    );

    const stale: StaleSession[] = [];
    for (const result of results) {
        if (result.status !== 'fulfilled') {
            continue;
        }
        const ageMs = now - result.value.mtimeMs;
        if (ageMs > maxAgeMs) {
            stale.push({
                sessionId: result.value.entry.replace(/\.json$/, ''),
                ageMs,
            });
        }
    }

    return stale;
}
