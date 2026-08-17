import crypto from 'node:crypto';
import { execa } from 'execa';
import type { TraceBranchRecord } from '../../types/trace.js';
import { redactDeep } from './redaction.js';
import {
    applyRecordCorrections,
    mergeOverrides,
} from './record-corrections.js';

export const TRACE_BRANCH = 'kodus/trace/v1';
export const TRACE_REF = `refs/heads/${TRACE_BRANCH}`;

/**
 * Records are sharded one file per branch, at a path derived from a hash of the
 * branch name. Two developers on different branches never touch the same file,
 * so the common case merges trivially and the non-fast-forward retry has almost
 * nothing to reconcile.
 */
export function recordPathForBranch(branchName: string): string {
    const hash = crypto.createHash('sha256').update(branchName).digest('hex');
    return `records/${hash.slice(0, 2)}/${hash}.json`;
}

async function git(
    gitRoot: string,
    args: string[],
    options: { input?: string; env?: Record<string, string> } = {},
): Promise<string> {
    const result = await execa('git', args, {
        cwd: gitRoot,
        input: options.input,
        env: options.env,
        reject: true,
    });
    return result.stdout;
}

async function gitQuiet(
    gitRoot: string,
    args: string[],
): Promise<string | null> {
    try {
        return await git(gitRoot, args);
    } catch {
        return null;
    }
}

export async function resolveTraceRef(
    gitRoot: string,
    remote?: string,
): Promise<string | null> {
    const local = await gitQuiet(gitRoot, ['rev-parse', '--verify', TRACE_REF]);
    if (local) {
        return TRACE_REF;
    }

    const selectedRemote = remote ?? (await resolveRemoteName(gitRoot));
    if (!selectedRemote) {
        return null;
    }
    const remoteRef = `refs/remotes/${selectedRemote}/${TRACE_BRANCH}`;
    const fromRemote = await gitQuiet(gitRoot, [
        'rev-parse',
        '--verify',
        remoteRef,
    ]);
    return fromRemote ? remoteRef : null;
}

/**
 * Every branch record on the decision branch. Reads straight out of the object
 * database — the orphan branch is never checked out, so nothing here can touch
 * the developer's working tree.
 */
export async function readAllBranchRecords(
    gitRoot: string,
    remote?: string,
): Promise<TraceBranchRecord[]> {
    const ref = await resolveTraceRef(gitRoot, remote);
    if (!ref) {
        return [];
    }

    const listing = await gitQuiet(gitRoot, [
        'ls-tree',
        '-r',
        '--name-only',
        ref,
    ]);
    if (!listing) {
        return [];
    }

    const paths = listing
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.endsWith('.json'));

    const records = await Promise.all(
        paths.map(async (recordPath) => {
            const raw = await gitQuiet(gitRoot, [
                'show',
                `${ref}:${recordPath}`,
            ]);
            if (!raw) {
                return null;
            }
            try {
                return JSON.parse(raw) as TraceBranchRecord;
            } catch {
                return null;
            }
        }),
    );

    return records.filter((record): record is TraceBranchRecord => !!record);
}

export async function readBranchRecord(
    gitRoot: string,
    branchName: string,
    remote?: string,
): Promise<TraceBranchRecord | null> {
    const ref = await resolveTraceRef(gitRoot, remote);
    if (!ref) {
        return null;
    }

    return readBranchRecordAtRef(gitRoot, branchName, ref);
}

async function readBranchRecordAtRef(
    gitRoot: string,
    branchName: string,
    ref: string,
): Promise<TraceBranchRecord | null> {
    const raw = await gitQuiet(gitRoot, [
        'show',
        `${ref}:${recordPathForBranch(branchName)}`,
    ]);
    if (!raw) {
        return null;
    }

    try {
        return JSON.parse(raw) as TraceBranchRecord;
    } catch {
        return null;
    }
}

/**
 * Write (replacing, never appending) a branch's record onto the orphan branch.
 *
 * Uses a throwaway index file so the developer's real index and worktree are
 * untouched — this runs from a pre-push hook, possibly while they are editing.
 */
export async function writeBranchRecord(
    gitRoot: string,
    record: TraceBranchRecord,
    options: { parentRef?: string | null; indexFile: string },
): Promise<{ commit: string }> {
    const recordPath = recordPathForBranch(record.branch);
    // Model output is untrusted free text. Sanitize the complete record at the
    // last boundary as well as during normalization so future fields inherit
    // the same guarantee.
    const payload = `${JSON.stringify(redactDeep(record), null, 2)}\n`;

    const blob = (
        await git(gitRoot, ['hash-object', '-w', '--stdin'], {
            input: payload,
        })
    ).trim();

    const env = { GIT_INDEX_FILE: options.indexFile };

    const parent =
        options.parentRef === undefined
            ? await resolveTraceRef(gitRoot)
            : options.parentRef;

    if (parent) {
        await git(gitRoot, ['read-tree', parent], { env });
    } else {
        await git(gitRoot, ['read-tree', '--empty'], { env });
    }

    await git(
        gitRoot,
        [
            'update-index',
            '--add',
            '--cacheinfo',
            `100644,${blob},${recordPath}`,
        ],
        { env },
    );

    const tree = (await git(gitRoot, ['write-tree'], { env })).trim();

    const parentSha = parent
        ? (await gitQuiet(gitRoot, ['rev-parse', parent]))?.trim()
        : null;

    const commitArgs = ['commit-tree', tree];
    if (parentSha) {
        commitArgs.push('-p', parentSha);
    }
    commitArgs.push('-m', `trace: ${record.branch}`);

    const commit = (
        await git(gitRoot, commitArgs, {
            env: {
                GIT_AUTHOR_NAME: 'Kodus Trace',
                GIT_AUTHOR_EMAIL: 'trace@kodus.io',
                GIT_COMMITTER_NAME: 'Kodus Trace',
                GIT_COMMITTER_EMAIL: 'trace@kodus.io',
            },
        })
    ).trim();

    await git(gitRoot, ['update-ref', TRACE_REF, commit]);

    return { commit };
}

export interface PushOutcome {
    pushed: boolean;
    retried: boolean;
    error?: string;
}

/**
 * Push the decision branch, retrying once on a non-fast-forward by rebuilding
 * the record on top of the fetched remote tip. A collision that survives the
 * retry is returned, not swallowed — `trace status` reports it.
 */
export async function pushTraceBranch(
    gitRoot: string,
    record: TraceBranchRecord,
    options: {
        remote?: string;
        indexFile: string;
        /** Immutable commit created for this operation (avoids local-ref races). */
        sourceCommit?: string;
        /** Corrections merge with a concurrent distillation of the same shard. */
        mergeRemoteDecisions?: boolean;
    },
): Promise<PushOutcome> {
    const remote = options.remote ?? 'origin';
    let sourceCommit = options.sourceCommit ?? TRACE_REF;

    const attempt = async (): Promise<string | null> => {
        try {
            await git(
                gitRoot,
                ['push', remote, `${sourceCommit}:${TRACE_REF}`],
                {
                    // Defense in depth. The installed hook also ignores the Trace
                    // ref, but this protects older/custom hooks during upgrades.
                    env: { KODUS_TRACE_SKIP: '1' },
                },
            );
            return null;
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    };

    const firstError = await attempt();
    if (!firstError) {
        return { pushed: true, retried: false };
    }

    // Rebase: refetch the remote tip and re-apply our single record on top of
    // it, then push again. Sharding means the tree we inherit already contains
    // everyone else's records, so nothing of theirs is lost.
    const fetched = await gitQuiet(gitRoot, [
        'fetch',
        remote,
        `${TRACE_REF}:refs/remotes/${remote}/${TRACE_BRANCH}`,
    ]);

    if (fetched === null) {
        return { pushed: false, retried: true, error: firstError };
    }

    try {
        const remoteRecord = await readBranchRecordAtRef(
            gitRoot,
            record.branch,
            `refs/remotes/${remote}/${TRACE_BRANCH}`,
        );
        const rebasedRecord = applyRecordCorrections({
            ...record,
            decisions: options.mergeRemoteDecisions
                ? mergeDecisions(
                      remoteRecord?.decisions ?? [],
                      record.decisions,
                  )
                : record.decisions,
            corrections: mergeOverrides(
                remoteRecord?.corrections,
                record.corrections,
            ),
        });
        const rewritten = await writeBranchRecord(gitRoot, rebasedRecord, {
            parentRef: `refs/remotes/${remote}/${TRACE_BRANCH}`,
            indexFile: options.indexFile,
        });
        sourceCommit = rewritten.commit;
    } catch (error) {
        return {
            pushed: false,
            retried: true,
            error: error instanceof Error ? error.message : String(error),
        };
    }

    const secondError = await attempt();
    if (!secondError) {
        return { pushed: true, retried: true };
    }

    return { pushed: false, retried: true, error: secondError };
}

function mergeDecisions(
    remote: TraceBranchRecord['decisions'],
    local: TraceBranchRecord['decisions'],
): TraceBranchRecord['decisions'] {
    const byId = new Map(remote.map((decision) => [decision.id, decision]));
    for (const decision of local) {
        byId.set(decision.id, decision);
    }
    return [...byId.values()];
}

/**
 * Make sure the decision branch is fetched by a plain `git fetch` in this
 * clone. The default wildcard already covers it; adding the explicit refspec is
 * idempotent and survives a narrowed `remote.<name>.fetch`.
 */
export async function configureTraceRefspec(
    gitRoot: string,
    remote?: string,
): Promise<{ configured: boolean; reason?: string }> {
    const remotes = await gitQuiet(gitRoot, ['remote']);
    const names = remotes?.split('\n').filter(Boolean) ?? [];
    const selectedRemote =
        remote ?? (names.includes('origin') ? 'origin' : names[0]);
    if (!selectedRemote || !names.includes(selectedRemote)) {
        return {
            configured: false,
            reason: remote ? `no "${remote}" remote` : 'no git remote',
        };
    }

    const key = `remote.${selectedRemote}.fetch`;
    const desired = `+${TRACE_REF}:refs/remotes/${selectedRemote}/${TRACE_BRANCH}`;

    const existing =
        (await gitQuiet(gitRoot, ['config', '--get-all', key])) ?? '';
    if (existing.split('\n').includes(desired)) {
        return { configured: false, reason: 'already configured' };
    }

    await git(gitRoot, ['config', '--add', key, desired]);
    return { configured: true };
}

async function resolveRemoteName(gitRoot: string): Promise<string | null> {
    const remotes = await gitQuiet(gitRoot, ['remote']);
    const names = remotes?.split('\n').filter(Boolean) ?? [];
    return names.includes('origin') ? 'origin' : (names[0] ?? null);
}
