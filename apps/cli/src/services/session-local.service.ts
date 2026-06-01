import fs from 'fs/promises';
import path from 'path';

export interface LocalSessionData {
    turnId: string;
    transcriptPath: string;
    transcriptOffset: number;
    /** Set to true after turn_end is sent — prevents duplicate turn_end events */
    turnCompleted?: boolean;
}

const SESSION_DIR = '.kody/sessions';

function sessionPath(repoRoot: string, sessionId: string): string {
    // Prevent path traversal attacks by ensuring sessionId is a simple filename.
    if (path.basename(sessionId) !== sessionId) {
        throw new Error(`Invalid sessionId: ${sessionId}`);
    }
    return path.join(repoRoot, SESSION_DIR, `${sessionId}.json`);
}

export async function saveLocal(
    repoRoot: string,
    sessionId: string,
    data: LocalSessionData,
): Promise<void> {
    const filePath = sessionPath(repoRoot, sessionId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data) + '\n', 'utf-8');
}

export async function loadLocal(
    repoRoot: string,
    sessionId: string,
): Promise<LocalSessionData | null> {
    try {
        const content = await fs.readFile(
            sessionPath(repoRoot, sessionId),
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
    try {
        await fs.unlink(sessionPath(repoRoot, sessionId));
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
    const filePath = sessionPath(repoRoot, sessionId);
    await fs.writeFile(filePath, JSON.stringify(data) + '\n', 'utf-8');
}

export interface StaleSession {
    sessionId: string;
    ageMs: number;
}

/**
 * List session files older than maxAgeMs.
 * Used on SessionStart to detect orphaned sessions from previous crashes.
 */
export async function listStaleSessions(
    repoRoot: string,
    maxAgeMs: number,
): Promise<StaleSession[]> {
    const dir = path.join(repoRoot, SESSION_DIR);
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
        if (result.status !== 'fulfilled') {continue;}
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
