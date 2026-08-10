import fs from 'node:fs/promises';
import path from 'node:path';
import {
    sessionRecordPath,
    sessionRecordsDir,
    sanitizeSessionId,
} from './store-paths.js';
import type {
    TraceRecordLine,
    TraceSession,
    TraceSessionSummary,
    TraceTurn,
} from '../../types/trace.js';
import { redactDeep } from './redaction.js';

/**
 * The durable half of capture: a JSONL file per session under
 * `~/.kodus/sessions/<repoKey>/records/`.
 *
 * JSONL rather than one JSON document on purpose — a session that is killed
 * mid-write leaves a truncated last line, and every reader here drops the bad
 * line and returns the turns that did land.
 */
export async function appendRecordLine(
    gitRoot: string,
    sessionId: string,
    line: TraceRecordLine,
): Promise<void> {
    const filePath = sessionRecordPath(gitRoot, sessionId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(
        filePath,
        `${JSON.stringify(redactDeep(line))}\n`,
        'utf-8',
    );
}

export async function readSessionRecord(
    gitRoot: string,
    sessionId: string,
): Promise<TraceSession | null> {
    const filePath = sessionRecordPath(gitRoot, sessionId);
    let raw: string;
    try {
        raw = await fs.readFile(filePath, 'utf-8');
    } catch {
        return null;
    }

    return parseSessionRecord(sanitizeSessionId(sessionId), raw);
}

export function parseSessionRecord(
    sessionId: string,
    raw: string,
): TraceSession {
    const session: TraceSession = {
        sessionId,
        turns: [],
        corruptLines: 0,
    };

    const turnsById = new Map<string, TraceTurn>();

    for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
            continue;
        }

        let line: TraceRecordLine;
        try {
            line = JSON.parse(trimmed) as TraceRecordLine;
        } catch {
            // Truncated tail or a partially flushed write — keep going.
            session.corruptLines += 1;
            continue;
        }

        switch (line?.kind) {
            case 'session-start':
                session.agentType = line.agentType;
                session.branch = line.branch;
                session.baseCommit = line.baseCommit;
                session.gitRemote = line.gitRemote;
                session.cliVersion = line.cliVersion;
                session.startedAt = line.timestamp;
                if (line.sessionId) {
                    session.sessionId = line.sessionId;
                }
                break;

            case 'turn-start': {
                const turn: TraceTurn = {
                    turnId: line.turnId,
                    prompt: line.prompt ?? '',
                    response: '',
                    toolCalls: [],
                    filesModified: [],
                    filesRead: [],
                    commands: [],
                    commitBefore: line.commitBefore,
                    startedAt: line.timestamp,
                };
                turnsById.set(line.turnId, turn);
                session.turns.push(turn);
                break;
            }

            case 'turn-end': {
                const existing = turnsById.get(line.turnId);
                const turn: TraceTurn = existing ?? {
                    turnId: line.turnId,
                    prompt: '',
                    response: '',
                    toolCalls: [],
                    filesModified: [],
                    filesRead: [],
                    commands: [],
                };
                turn.response = line.response ?? '';
                turn.toolCalls = line.toolCalls ?? [];
                turn.filesModified = line.filesModified ?? [];
                turn.filesRead = line.filesRead ?? [];
                turn.commands = line.commands ?? [];
                turn.tokenUsage = line.tokenUsage;
                turn.commitAfter = line.commitAfter;
                turn.endedAt = line.timestamp;
                if (!existing) {
                    turnsById.set(line.turnId, turn);
                    session.turns.push(turn);
                }
                break;
            }

            case 'session-end':
                session.endedAt = line.timestamp;
                break;

            default:
                session.corruptLines += 1;
                break;
        }
    }

    return session;
}

export async function listSessionIds(gitRoot: string): Promise<string[]> {
    const dir = sessionRecordsDir(gitRoot);
    try {
        const entries = await fs.readdir(dir);
        return entries
            .filter((entry) => entry.endsWith('.jsonl'))
            .map((entry) => entry.replace(/\.jsonl$/, ''))
            .sort();
    } catch {
        return [];
    }
}

export async function listSessions(
    gitRoot: string,
): Promise<TraceSessionSummary[]> {
    const ids = await listSessionIds(gitRoot);
    const dir = sessionRecordsDir(gitRoot);

    const summaries = await Promise.all(
        ids.map(async (sessionId) => {
            const filePath = path.join(dir, `${sessionId}.jsonl`);
            try {
                const [raw, stat] = await Promise.all([
                    fs.readFile(filePath, 'utf-8'),
                    fs.stat(filePath),
                ]);
                const session = parseSessionRecord(sessionId, raw);
                return toSummary(session, stat.mtime.toISOString());
            } catch {
                return null;
            }
        }),
    );

    return summaries
        .filter((entry): entry is TraceSessionSummary => entry !== null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function toSummary(
    session: TraceSession,
    updatedAt: string,
): TraceSessionSummary {
    const filesTouched = new Set<string>();
    for (const turn of session.turns) {
        for (const change of turn.filesModified) {
            if (change?.path) {
                filesTouched.add(change.path);
            }
        }
    }

    return {
        sessionId: session.sessionId,
        agentType: session.agentType,
        branch: session.branch,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        turnCount: session.turns.length,
        filesTouched: [...filesTouched].sort(),
        updatedAt,
    };
}

export const SESSION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Drop session records older than `maxAgeMs`. Runs at session-start, where it
 * is cheap and where a developer who left the machine idle for a quarter gets
 * their disk back without ever thinking about it.
 */
export async function pruneOldSessions(
    gitRoot: string,
    maxAgeMs: number = SESSION_RETENTION_MS,
    now: number = Date.now(),
): Promise<string[]> {
    const dir = sessionRecordsDir(gitRoot);
    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return [];
    }

    const pruned: string[] = [];

    await Promise.all(
        entries
            .filter((entry) => entry.endsWith('.jsonl'))
            .map(async (entry) => {
                const filePath = path.join(dir, entry);
                try {
                    const stat = await fs.stat(filePath);
                    if (now - stat.mtimeMs <= maxAgeMs) {
                        return;
                    }
                    await fs.unlink(filePath);
                    pruned.push(entry.replace(/\.jsonl$/, ''));
                } catch {
                    // A record we cannot stat or unlink is not worth failing on.
                }
            }),
    );

    return pruned.sort();
}

export async function lastCaptureAt(gitRoot: string): Promise<string | null> {
    const dir = sessionRecordsDir(gitRoot);
    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return null;
    }

    let newest = 0;
    await Promise.all(
        entries
            .filter((entry) => entry.endsWith('.jsonl'))
            .map(async (entry) => {
                try {
                    const stat = await fs.stat(path.join(dir, entry));
                    newest = Math.max(newest, stat.mtimeMs);
                } catch {
                    // Ignore
                }
            }),
    );

    return newest > 0 ? new Date(newest).toISOString() : null;
}
