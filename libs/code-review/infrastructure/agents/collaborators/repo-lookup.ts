/**
 * Repository lookup with an explicit capability signal (issue #1826).
 *
 * The review pipeline cannot currently tell "I looked and found nothing" from
 * "I could not look". `NULL_SANDBOX_INSTANCE` answers `grep` and `read` with
 * `''` AND success, and the lease manager hands that object out as an ordinary
 * sandbox — so every consumer downstream reads silence as evidence. That is the
 * failure the claim checker and the context retriever must not inherit: a
 * finding refuted by an empty grep would be "confirmed" by a sandbox that never
 * ran one.
 *
 * So this wrapper does two things and nothing else:
 *
 *   1. It derives `available` from the sandbox handle's own `type` — the signal
 *      already exists in state and is simply discarded on the way to the agents.
 *   2. When unavailable, every accessor THROWS instead of returning empty.
 *      Callers then have to decide, and the decision is visible in a stack
 *      trace rather than in a silently missing comment.
 *
 * The throw lives here rather than inside `NULL_SANDBOX_INSTANCE` on purpose:
 * that object has direct consumers outside this feature which tolerate empty
 * reads today, and changing it globally would be a much wider blast radius than
 * this feature needs.
 */
import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

/** Thrown by every accessor when the repository cannot be looked at. */
export class RepoLookupUnavailableError extends Error {
    constructor(operation: string, reason: string) {
        super(
            `repo lookup unavailable (${reason}): cannot ${operation}. An empty result would be indistinguishable from a real absence, so the caller must fail closed instead.`,
        );
        this.name = 'RepoLookupUnavailableError';
    }
}

export interface RepoLookup {
    /** False when there is no sandbox, when it is the null sandbox, or once
     *  `probe` has caught the lookup answering with silence. */
    readonly available: boolean;
    /** Why the lookup is unavailable, for logs. Empty while available. */
    readonly unavailableReason: string;
    grep(pattern: string, path?: string, glob?: string): Promise<string>;
    read(path: string, start: number, end: number): Promise<string>;
    /**
     * Whether `path` exists in the repository.
     *
     * Returns false ONLY when the parent directory listed successfully and the
     * path was not in it. Any transport failure propagates, because "I could
     * not check" must never be reported as "it is not there" — a `missing`
     * claim confirmed by a broken lookup is precisely the bug this module
     * exists to stop.
     */
    exists(path: string): Promise<boolean>;
    /**
     * Positive control. Reads a file this PR is known to have changed; empty
     * content back from an allegedly available lookup means the lookup is lying,
     * so availability is flipped off for the rest of the review and recorded.
     */
    probe(knownChangedFile: string): Promise<void>;
}

export interface RepoLookupLogger {
    warn: (entry: {
        message: string;
        context?: string;
        metadata?: Record<string, unknown>;
    }) => void;
}

const parentDirOf = (filePath: string): string => {
    const idx = filePath.lastIndexOf('/');
    return idx <= 0 ? '.' : filePath.slice(0, idx);
};

const normalize = (p: string): string => p.replace(/^\.\//, '').trim();

/**
 * Build the lookup for one review from the sandbox handle the pipeline already
 * carries. `undefined` (no sandbox at all, e.g. the trial flow) and a handle of
 * `type: 'null'` are the same thing here: unavailable.
 */
export function buildRepoLookup(
    handle: SandboxInstance | undefined,
    logger?: RepoLookupLogger,
): RepoLookup {
    const remote: RemoteCommands | undefined = handle?.remoteCommands;

    let reason = '';
    if (!handle) {
        reason = 'no sandbox handle';
    } else if (handle.type === 'null') {
        reason = 'null sandbox';
    } else if (!remote) {
        reason = 'sandbox handle carries no remote commands';
    }

    let available = reason === '';

    const guard = (operation: string): void => {
        if (!available) {
            throw new RepoLookupUnavailableError(operation, reason);
        }
    };

    const disable = (why: string, metadata: Record<string, unknown>): void => {
        available = false;
        reason = why;
        logger?.warn({
            message: `[repo-lookup] disabled for the rest of this review — ${why}`,
            context: 'repo-lookup',
            metadata,
        });
    };

    return {
        get available() {
            return available;
        },
        get unavailableReason() {
            return available ? '' : reason;
        },

        async grep(pattern: string, path = '.', glob?: string) {
            guard(`grep ${JSON.stringify(pattern)}`);
            return remote!.grep(pattern, path, glob);
        },

        async read(path: string, start: number, end: number) {
            guard(`read ${path}`);
            return remote!.read(path, start, end);
        },

        async exists(path: string) {
            guard(`check whether ${path} exists`);
            const listing = await remote!.listDir(parentDirOf(path), 1);
            const wanted = normalize(path);
            return listing
                .split('\n')
                .map(normalize)
                .some((entry) => entry === wanted);
        },

        async probe(knownChangedFile: string) {
            if (!available) {
                return;
            }
            let content: string;
            try {
                content = await remote!.read(knownChangedFile, 0, 0);
            } catch (err) {
                disable('a read of a known changed file threw', {
                    file: knownChangedFile,
                    err: err instanceof Error ? err.message : String(err),
                });
                return;
            }
            if (!content.trim()) {
                disable('a read of a known changed file came back empty', {
                    file: knownChangedFile,
                });
            }
        },
    };
}
