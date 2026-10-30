import path from 'node:path';
import { readAllBranchRecords } from './decision-branch.service.js';
import { readAllLocalBranchRecords } from './local-decisions.js';
import { readOverrides } from './overrides.js';
import type {
    TraceBranchRecord,
    TraceDecision,
    TraceRecalledDecision,
} from '../../types/trace.js';

/**
 * Normalize a path the way both the query side and the scope side have to see
 * it: repo-relative, posix separators, no leading `./`, no trailing slash.
 */
export function normalizeScopePath(rawPath: string, gitRoot?: string): string {
    let value = rawPath.trim();
    if (!value) {
        return '';
    }

    if (gitRoot && path.isAbsolute(value)) {
        value = path.relative(gitRoot, value);
    }

    value = value.split(path.sep).join('/');
    value = value.replace(/^\.\//, '').replace(/\/+$/, '');

    return value;
}

/**
 * Exact or prefix comparison in both directions:
 *
 * - scope `src/billing` matches a query for `src/billing/invoice.ts`
 * - scope `src/billing/invoice.ts` matches a query for the `src/billing` dir
 *
 * There is deliberately no embedding, vector store or similarity search here.
 * Semantic recall is a different feature.
 */
export function scopeMatches(scopeEntry: string, queryPath: string): boolean {
    const scope = normalizeScopePath(scopeEntry);
    const query = normalizeScopePath(queryPath);

    if (!scope || !query) {
        return false;
    }

    return (
        scope === query ||
        query.startsWith(`${scope}/`) ||
        scope.startsWith(`${query}/`)
    );
}

export interface RecallOptions {
    /** Empty means "everything recorded for this repository". */
    paths?: string[];
    remote?: string;
    limit?: number;
}

export interface RecallResult {
    decisions: TraceRecalledDecision[];
    queriedPaths: string[];
    sources: { local: number; branch: number };
}

/**
 * Path-keyed recall over both stores. No network access: the branch records are
 * read out of the local object database, including refs fetched from the
 * remote by an ordinary `git fetch`.
 */
export async function recallDecisions(
    gitRoot: string,
    options: RecallOptions = {},
): Promise<RecallResult> {
    const queriedPaths = (options.paths ?? [])
        .map((entry) => normalizeScopePath(entry, gitRoot))
        .filter(Boolean);

    const [localRecords, branchRecords, overrides] = await Promise.all([
        readAllLocalBranchRecords(gitRoot),
        readAllBranchRecords(gitRoot, options.remote).catch(
            () => [] as TraceBranchRecord[],
        ),
        readOverrides(gitRoot),
    ]);

    const allRecords = [...localRecords, ...branchRecords];
    const forgotten = new Set([
        ...overrides.forgotten,
        ...allRecords.flatMap((record) => record.corrections?.forgotten ?? []),
    ]);
    const pinned = new Set([
        ...overrides.pinned,
        ...allRecords.flatMap((record) => record.corrections?.pinned ?? []),
    ]);

    const collected = new Map<string, TraceRecalledDecision>();

    const ingest = (
        records: TraceBranchRecord[],
        source: 'local' | 'branch',
    ): void => {
        for (const record of records) {
            for (const decision of record.decisions ?? []) {
                if (!decision?.id || forgotten.has(decision.id)) {
                    continue;
                }

                const matchedPaths = matchPaths(decision, queriedPaths);
                if (queriedPaths.length > 0 && matchedPaths.length === 0) {
                    continue;
                }

                const existing = collected.get(decision.id);
                if (existing) {
                    // A decision present in both stores keeps the local copy —
                    // it is the newer of the two by construction — but records
                    // that it also travelled with the repository.
                    existing.matchedPaths = [
                        ...new Set([...existing.matchedPaths, ...matchedPaths]),
                    ];
                    continue;
                }

                collected.set(decision.id, {
                    ...decision,
                    branch: decision.branch ?? record.branch,
                    pinned: pinned.has(decision.id) || decision.pinned === true,
                    source,
                    matchedPaths,
                });
            }
        }
    };

    ingest(localRecords, 'local');
    ingest(branchRecords, 'branch');

    const decisions = [...collected.values()].sort(compareDecisions);
    const limited =
        options.limit && options.limit > 0
            ? decisions.slice(0, options.limit)
            : decisions;

    return {
        decisions: limited,
        queriedPaths,
        sources: {
            local: localRecords.length,
            branch: branchRecords.length,
        },
    };
}

function matchPaths(decision: TraceDecision, queried: string[]): string[] {
    if (queried.length === 0) {
        return [];
    }

    const matched = new Set<string>();
    for (const queryPath of queried) {
        for (const scopeEntry of decision.scope ?? []) {
            if (scopeMatches(scopeEntry, queryPath)) {
                matched.add(queryPath);
                break;
            }
        }
    }

    return [...matched];
}

function compareDecisions(
    a: TraceRecalledDecision,
    b: TraceRecalledDecision,
): number {
    if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
    }

    const confidenceDelta = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (confidenceDelta !== 0) {
        return confidenceDelta;
    }

    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
}
