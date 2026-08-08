import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    listSessionRecords,
    loadForgottenIds,
    loadPinnedIds,
    type LocalDecision,
} from './local-session-store.service.js';
import { filterDecisionsByPaths } from './path-match.service.js';
import { hashPath } from './kodus-paths.service.js';

const execFileAsync = promisify(execFile);

export const TRACE_ORPHAN_BRANCH = 'kodus/trace/v1';
export const TRACE_TRAILER_PREFIX = 'Kodus-Trace:';

/**
 * Shard path for a branch decision record on the orphan branch.
 * Path is derived from a hash of the branch name so concurrent writers on
 * different branches never collide on the same file.
 */
export function branchRecordShardPath(branchName: string): string {
    const h = hashPath(branchName);
    return path.posix.join('branches', h.slice(0, 2), `${h}.json`);
}

export interface BranchDecisionRecord {
    id: string;
    branch: string;
    headSha?: string;
    range?: string;
    decisions: LocalDecision[];
    updatedAt: string;
}

/**
 * Collect decisions from local sessions (not forgotten).
 */
export async function collectLocalDecisions(
    repoRoot: string,
): Promise<LocalDecision[]> {
    const [records, forgotten, pinned] = await Promise.all([
        listSessionRecords(repoRoot),
        loadForgottenIds(repoRoot),
        loadPinnedIds(repoRoot),
    ]);

    const out: LocalDecision[] = [];
    for (const record of records) {
        for (const d of record.decisions) {
            if (d.forgotten || forgotten.has(d.id)) {
                continue;
            }
            out.push({
                ...d,
                pinned: d.pinned || pinned.has(d.id),
                source: 'local',
                sessionId: record.sessionId,
                branch: record.branch,
            });
        }
    }
    return out;
}

/**
 * Read decision records from the orphan branch without checking it out.
 * Fail-open: returns [] if the branch does not exist.
 */
export async function collectBranchDecisions(
    repoRoot: string,
): Promise<LocalDecision[]> {
    const forgotten = await loadForgottenIds(repoRoot);
    const pinned = await loadPinnedIds(repoRoot);

    let files: string[];
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['ls-tree', '-r', '--name-only', TRACE_ORPHAN_BRANCH],
            { cwd: repoRoot },
        );
        files = stdout
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.endsWith('.json'));
    } catch {
        return [];
    }

    const decisions: LocalDecision[] = [];
    for (const file of files) {
        try {
            const { stdout } = await execFileAsync(
                'git',
                ['show', `${TRACE_ORPHAN_BRANCH}:${file}`],
                { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
            );
            const record = JSON.parse(stdout) as BranchDecisionRecord;
            for (const d of record.decisions ?? []) {
                if (d.forgotten || forgotten.has(d.id)) {
                    continue;
                }
                decisions.push({
                    ...d,
                    pinned: d.pinned || pinned.has(d.id),
                    source: 'branch',
                    branch: record.branch ?? d.branch,
                });
            }
        } catch {
            // partial / unreadable record — skip
        }
    }
    return decisions;
}

/**
 * Path-scoped recall: local sessions + orphan branch, offline.
 */
export async function recallDecisions(
    repoRoot: string,
    queryPaths: string[],
): Promise<LocalDecision[]> {
    const [local, branch] = await Promise.all([
        collectLocalDecisions(repoRoot),
        collectBranchDecisions(repoRoot),
    ]);

    // Deduplicate by id, preferring pinned / higher confidence
    const byId = new Map<string, LocalDecision>();
    for (const d of [...local, ...branch]) {
        const existing = byId.get(d.id);
        if (!existing) {
            byId.set(d.id, d);
            continue;
        }
        if (d.pinned && !existing.pinned) {
            byId.set(d.id, d);
            continue;
        }
        if ((d.confidence ?? 0) > (existing.confidence ?? 0)) {
            byId.set(d.id, d);
        }
    }

    const all = [...byId.values()];
    if (queryPaths.length === 0) {
        return all.filter((d) => !d.forgotten);
    }
    return filterDecisionsByPaths(all, queryPaths);
}

/**
 * Format decisions for human/agent stdout.
 */
export function formatDecisions(decisions: LocalDecision[]): string {
    if (decisions.length === 0) {
        return '';
    }
    return decisions
        .map((d) => {
            const pin = d.pinned ? ' [pinned]' : '';
            const conf =
                typeof d.confidence === 'number'
                    ? ` conf=${d.confidence.toFixed(2)}`
                    : '';
            const paths =
                d.paths && d.paths.length > 0
                    ? `\n  paths: ${d.paths.join(', ')}`
                    : '';
            const rationale = d.rationale ? `\n  why: ${d.rationale}` : '';
            return `- [${d.id}] (${d.type}${conf})${pin} ${d.decision}${rationale}${paths}`;
        })
        .join('\n');
}

/**
 * Rough token estimate for context-pack budgeting (~4 chars/token).
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export const CONTEXT_PACK_TOKEN_BUDGET = 2000;

/**
 * Select decisions for the review context pack:
 * - path-scoped to changed files
 * - cap at 2000 tokens
 * - drop lowest confidence first
 * - pinned decisions are never dropped
 */
export function selectContextPackDecisions(
    decisions: LocalDecision[],
    changedPaths: string[],
    budgetTokens = CONTEXT_PACK_TOKEN_BUDGET,
): LocalDecision[] {
    const matched = filterDecisionsByPaths(decisions, changedPaths);
    const pinned = matched.filter((d) => d.pinned);
    const unpinned = matched
        .filter((d) => !d.pinned)
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

    const selected: LocalDecision[] = [...pinned];
    let used = estimateTokens(formatDecisions(selected));

    for (const d of unpinned) {
        const next = estimateTokens(formatDecisions([...selected, d]));
        if (next > budgetTokens && selected.length > 0) {
            // Would exceed budget — skip (lowest confidence already at end)
            continue;
        }
        if (next > budgetTokens && selected.length === 0) {
            // Single decision larger than budget: still include pinned-only path;
            // for unpinned, skip oversized items.
            continue;
        }
        selected.push(d);
        used = next;
    }

    // If budget still exceeded solely because of pins, keep all pins (never drop).
    void used;
    return selected;
}

/**
 * Render the context pack block injected into the review prompt.
 * Returns empty string when there are no decisions (inert).
 */
export function renderContextPack(decisions: LocalDecision[]): string {
    if (decisions.length === 0) {
        return '';
    }
    return [
        '## Kodus Trace — decisions for changed files',
        '',
        'The following decisions were recorded while this code was written.',
        'Treat deliberate tradeoffs as intentional unless the diff clearly regresses them.',
        '',
        formatDecisions(decisions),
    ].join('\n');
}

/**
 * Pure helper used by tests asserting no embedding/vector deps.
 */
export function recallStrategy(): 'path-prefix' {
    return 'path-prefix';
}
