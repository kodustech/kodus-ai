import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * Everything Kodus Trace writes lives outside the repository working tree.
 *
 * The store is keyed by a hash of the git root path — not the remote — so a
 * repository with no remote still works, and a linked worktree (which has its
 * own git root) gets its own space instead of scribbling over the main
 * checkout's sessions.
 */
export function traceHome(): string {
    const override = process.env.KODUS_TRACE_HOME?.trim();
    if (override) {
        return path.resolve(override);
    }
    return path.join(os.homedir(), '.kodus');
}

export function repoKey(gitRoot: string): string {
    return crypto
        .createHash('sha256')
        .update(path.resolve(gitRoot))
        .digest('hex')
        .slice(0, 16);
}

/** `~/.kodus/sessions` — the root the whole feature is documented under. */
export function sessionsRoot(): string {
    return path.join(traceHome(), 'sessions');
}

/** `~/.kodus/sessions/<repoKey>` */
export function repoStoreDir(gitRoot: string): string {
    return path.join(sessionsRoot(), repoKey(gitRoot));
}

/** Durable, human-readable session records (one JSONL file per session). */
export function sessionRecordsDir(gitRoot: string): string {
    return path.join(repoStoreDir(gitRoot), 'records');
}

export function sessionRecordPath(gitRoot: string, sessionId: string): string {
    return path.join(sessionRecordsDir(gitRoot), `${safeId(sessionId)}.jsonl`);
}

/** Ephemeral per-turn bookkeeping (transcript offsets, dedup flags). */
export function turnStateDir(gitRoot: string): string {
    return path.join(repoStoreDir(gitRoot), 'state');
}

/** Offline buffer for API events. Never inside the repository. */
export function pendingEventsPath(gitRoot: string): string {
    return path.join(repoStoreDir(gitRoot), 'pending-events.jsonl');
}

export function hookLogPath(gitRoot: string): string {
    return path.join(repoStoreDir(gitRoot), 'logs', 'hooks.jsonl');
}

/** Locally distilled decision records, one file per branch. */
export function localDecisionsDir(gitRoot: string): string {
    return path.join(repoStoreDir(gitRoot), 'decisions');
}

/** Cache of per-commit summaries so a reprocess only pays for new commits. */
export function commitSummaryDir(gitRoot: string): string {
    return path.join(repoStoreDir(gitRoot), 'commit-summaries');
}

/** `forget` / `pin` corrections applied on top of whatever the model produced. */
export function overridesPath(gitRoot: string): string {
    return path.join(repoStoreDir(gitRoot), 'overrides.json');
}

/** Things that failed in a way `trace status` has to be able to report. */
export function incidentsPath(gitRoot: string): string {
    return path.join(repoStoreDir(gitRoot), 'incidents.jsonl');
}

/** Machine-wide trace config (chosen agent CLI, etc.). */
export function traceConfigPath(): string {
    return path.join(traceHome(), 'trace-config.json');
}

function safeId(id: string): string {
    const trimmed = id.trim();
    if (!trimmed) {
        return 'unknown';
    }
    // Session ids come from third-party agents; never let one escape the store.
    return trimmed.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

export { safeId as sanitizeSessionId };
