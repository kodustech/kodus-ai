import fs from 'fs/promises';
import path from 'path';
import type { RedactedString } from './redaction.service.js';
import { ensureDir, getSessionsDir, hashPath } from './kodus-paths.service.js';

export interface LocalDecision {
    id: string;
    type: string;
    origin?: string;
    decision: string;
    rationale?: string;
    confidence?: number;
    evidence?: string[];
    autoPromoteCandidate?: boolean;
    /** Paths this decision applies to */
    paths?: string[];
    pinned?: boolean;
    forgotten?: boolean;
    source: 'local' | 'branch';
    sessionId?: string;
    branch?: string;
    createdAt?: string;
}

export interface LocalTurnRecord {
    turnId: string;
    prompt: RedactedString | string;
    response: RedactedString | string;
    toolCalls: Array<{ tool?: string; toolName?: string; summary?: string }>;
    filesModified: string[];
    filesRead: string[];
    commands: string[];
    timestamp: string;
}

export interface LocalSessionRecord {
    sessionId: string;
    agentType?: string;
    branch?: string;
    gitRemote?: string;
    worktreeRoot: string;
    startedAt: string;
    endedAt?: string;
    turns: LocalTurnRecord[];
    decisions: LocalDecision[];
    filesTouched: string[];
    lastCaptureAt: string;
    cliVersion?: string;
}

const SESSION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const KEEP_THRESHOLD_MS = 89 * 24 * 60 * 60 * 1000;

function sessionFilePath(sessionsDir: string, sessionId: string): string {
    if (path.basename(sessionId) !== sessionId) {
        throw new Error(`Invalid sessionId: ${sessionId}`);
    }
    return path.join(sessionsDir, `${sessionId}.json`);
}

export async function loadSessionRecord(
    repoRoot: string,
    sessionId: string,
): Promise<LocalSessionRecord | null> {
    const dir = await getSessionsDir(repoRoot);
    try {
        const raw = await fs.readFile(sessionFilePath(dir, sessionId), 'utf-8');
        return JSON.parse(raw) as LocalSessionRecord;
    } catch {
        return null;
    }
}

export async function saveSessionRecord(
    repoRoot: string,
    record: LocalSessionRecord,
): Promise<string> {
    const dir = await getSessionsDir(repoRoot);
    await ensureDir(dir);
    const filePath = sessionFilePath(dir, record.sessionId);
    await fs.writeFile(
        filePath,
        JSON.stringify(record, null, 2) + '\n',
        'utf-8',
    );
    return filePath;
}

export async function listSessionRecords(
    repoRoot: string,
): Promise<LocalSessionRecord[]> {
    const dir = await getSessionsDir(repoRoot);
    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return [];
    }

    const records: LocalSessionRecord[] = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json')) {
            continue;
        }
        // Skip control files and nested state dirs
        if (entry.startsWith('_') || entry === 'package.json') {
            continue;
        }
        try {
            const raw = await fs.readFile(path.join(dir, entry), 'utf-8');
            const parsed = JSON.parse(raw) as LocalSessionRecord;
            if (!parsed || typeof parsed !== 'object' || !parsed.sessionId) {
                continue;
            }
            if (!Array.isArray(parsed.decisions)) {
                parsed.decisions = [];
            }
            if (!Array.isArray(parsed.turns)) {
                parsed.turns = [];
            }
            records.push(parsed);
        } catch {
            // Skip truncated / partial records rather than failing the list.
        }
    }
    return records.sort(
        (a, b) =>
            new Date(b.lastCaptureAt || b.startedAt).getTime() -
            new Date(a.lastCaptureAt || a.startedAt).getTime(),
    );
}

/**
 * Prune sessions older than 90 days. A session at 89 days is kept.
 * Returns the number of pruned files.
 */
export async function pruneOldSessions(
    repoRoot: string,
    now = Date.now(),
): Promise<number> {
    const dir = await getSessionsDir(repoRoot);
    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return 0;
    }

    let pruned = 0;
    for (const entry of entries) {
        if (!entry.endsWith('.json')) {
            continue;
        }
        const filePath = path.join(dir, entry);
        try {
            const stat = await fs.stat(filePath);
            const age = now - stat.mtimeMs;
            // Keep anything under 90 days. Explicitly keep 89-day-old sessions.
            if (age > SESSION_RETENTION_MS) {
                await fs.unlink(filePath);
                pruned += 1;
            }
        } catch {
            // ignore
        }
    }
    return pruned;
}

/** Exported for tests that need exact threshold numbers. */
export const SESSION_PRUNE = {
    RETENTION_MS: SESSION_RETENTION_MS,
    KEEP_THRESHOLD_MS: KEEP_THRESHOLD_MS,
} as const;

export async function upsertTurn(
    repoRoot: string,
    sessionId: string,
    partial: Partial<LocalSessionRecord> & {
        turn?: LocalTurnRecord;
        worktreeRoot: string;
    },
): Promise<LocalSessionRecord> {
    const existing = (await loadSessionRecord(repoRoot, sessionId)) ?? {
        sessionId,
        worktreeRoot: partial.worktreeRoot,
        startedAt: new Date().toISOString(),
        turns: [],
        decisions: [],
        filesTouched: [],
        lastCaptureAt: new Date().toISOString(),
    };

    if (partial.agentType) {
        existing.agentType = partial.agentType;
    }
    if (partial.branch) {
        existing.branch = partial.branch;
    }
    if (partial.gitRemote) {
        existing.gitRemote = partial.gitRemote;
    }
    if (partial.cliVersion) {
        existing.cliVersion = partial.cliVersion;
    }
    if (partial.endedAt) {
        existing.endedAt = partial.endedAt;
    }
    if (partial.turn) {
        const idx = existing.turns.findIndex(
            (t) => t.turnId === partial.turn!.turnId,
        );
        if (idx >= 0) {
            const prev = existing.turns[idx];
            const next = { ...partial.turn };
            // Do not clobber a non-empty prompt/response with an empty update
            // (turn_end often re-saves the same turnId without re-including prompt).
            if (!next.prompt && prev.prompt) {
                next.prompt = prev.prompt;
            }
            if (!next.response && prev.response) {
                next.response = prev.response;
            }
            if (
                (!next.toolCalls || next.toolCalls.length === 0) &&
                prev.toolCalls?.length
            ) {
                next.toolCalls = prev.toolCalls;
            }
            if (
                (!next.filesModified || next.filesModified.length === 0) &&
                prev.filesModified?.length
            ) {
                next.filesModified = prev.filesModified;
            }
            existing.turns[idx] = { ...prev, ...next };
        } else {
            existing.turns.push(partial.turn);
        }
        for (const f of partial.turn.filesModified ?? []) {
            if (!existing.filesTouched.includes(f)) {
                existing.filesTouched.push(f);
            }
        }
        for (const f of partial.turn.filesRead ?? []) {
            if (!existing.filesTouched.includes(f)) {
                existing.filesTouched.push(f);
            }
        }
    }
    if (partial.decisions) {
        existing.decisions = partial.decisions;
    }
    existing.lastCaptureAt = new Date().toISOString();
    existing.worktreeRoot = partial.worktreeRoot || existing.worktreeRoot;

    await saveSessionRecord(repoRoot, existing);
    return existing;
}

/**
 * Generate a stable decision id from content.
 */
export function decisionIdFromContent(
    decision: string,
    sessionId: string,
    index: number,
): string {
    return hashPath(`${sessionId}:${index}:${decision}`).slice(0, 12);
}

/**
 * Mark a decision forgotten across all local sessions.
 */
export async function forgetDecision(
    repoRoot: string,
    decisionId: string,
): Promise<boolean> {
    const records = await listSessionRecords(repoRoot);
    let found = false;
    for (const record of records) {
        let changed = false;
        for (const d of record.decisions) {
            if (d.id === decisionId) {
                d.forgotten = true;
                changed = true;
                found = true;
            }
        }
        if (changed) {
            await saveSessionRecord(repoRoot, record);
        }
    }
    // Also record in a forgotten-ids file so branch decisions can be filtered.
    const dir = await getSessionsDir(repoRoot);
    await ensureDir(dir);
    const forgottenPath = path.join(dir, '_forgotten.json');
    let ids: string[];
    try {
        ids = JSON.parse(await fs.readFile(forgottenPath, 'utf-8')) as string[];
    } catch {
        ids = [];
    }
    if (!ids.includes(decisionId)) {
        ids.push(decisionId);
        await fs.writeFile(
            forgottenPath,
            JSON.stringify(ids, null, 2) + '\n',
            'utf-8',
        );
        found = true;
    }
    return found;
}

export async function pinDecision(
    repoRoot: string,
    decisionId: string,
): Promise<boolean> {
    const records = await listSessionRecords(repoRoot);
    let found = false;
    for (const record of records) {
        let changed = false;
        for (const d of record.decisions) {
            if (d.id === decisionId) {
                d.pinned = true;
                changed = true;
                found = true;
            }
        }
        if (changed) {
            await saveSessionRecord(repoRoot, record);
        }
    }
    const dir = await getSessionsDir(repoRoot);
    await ensureDir(dir);
    const pinnedPath = path.join(dir, '_pinned.json');
    let ids: string[];
    try {
        ids = JSON.parse(await fs.readFile(pinnedPath, 'utf-8')) as string[];
    } catch {
        ids = [];
    }
    if (!ids.includes(decisionId)) {
        ids.push(decisionId);
        await fs.writeFile(
            pinnedPath,
            JSON.stringify(ids, null, 2) + '\n',
            'utf-8',
        );
        found = true;
    }
    return found;
}

export async function loadForgottenIds(repoRoot: string): Promise<Set<string>> {
    const dir = await getSessionsDir(repoRoot);
    try {
        const ids = JSON.parse(
            await fs.readFile(path.join(dir, '_forgotten.json'), 'utf-8'),
        ) as string[];
        return new Set(ids);
    } catch {
        return new Set();
    }
}

export async function loadPinnedIds(repoRoot: string): Promise<Set<string>> {
    const dir = await getSessionsDir(repoRoot);
    try {
        const ids = JSON.parse(
            await fs.readFile(path.join(dir, '_pinned.json'), 'utf-8'),
        ) as string[];
        return new Set(ids);
    } catch {
        return new Set();
    }
}
