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
import type { LogArguments } from '@libs/core/log/logger';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

/**
 * What a provider answers when `grep` matched nothing.
 *
 * The two providers disagree: E2B returns this sentence, LocalSandbox returns
 * an empty string. Both mean "no occurrence", so every consumer has to accept
 * either — and the string lives here, beside the contract, rather than being
 * retyped per consumer (issue #1826: the retriever had its own idea and showed
 * the model the literal "No matches found." as if it were a repository slice).
 */
export const GREP_NO_MATCHES = 'No matches found.';

/** True when a grep answer carries no occurrence, in either provider's form. */
export const grepIsEmpty = (output: string): boolean => {
    const text = output?.trim() ?? '';
    return !text || text === GREP_NO_MATCHES;
};

/** Thrown by every accessor when the repository cannot be looked at. */
export class RepoLookupUnavailableError extends Error {
    constructor(operation: string, reason: string) {
        super(
            `repo lookup unavailable (${reason}): cannot ${operation}. An empty result would be indistinguishable from a real absence, so the caller must fail closed instead.`,
        );
        this.name = 'RepoLookupUnavailableError';
    }
}

/**
 * How much the repository was actually consulted during one review.
 *
 * A lookup can be `available` and still answer nothing useful — a sandbox that
 * went quiet, a repo that failed to clone, an `rg` that times out on every
 * call. Downstream that shows up only as findings quietly not being made, which
 * is indistinguishable from a clean PR. Counting the calls and the failures
 * makes the difference observable instead of inferred.
 */
export interface RepoLookupStats {
    grep: number;
    read: number;
    exists: number;
    /** Accessor calls that raised. A non-zero count with `available: true` is
     *  the shape of a degraded review that still reported success. */
    failures: number;
}

export interface RepoLookup {
    /** Call counts for this review. Read it when the run ends. */
    readonly stats: RepoLookupStats;
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

/**
 * Structurally what `createLogger()` hands back. Same latent shape mismatch the
 * claim checker had: `LogArguments.context` is required, so declaring it
 * optional here made a real `SimpleLogger` unassignable.
 */
export interface RepoLookupLogger {
    warn: (entry: LogArguments) => void;
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

    const stats: RepoLookupStats = { grep: 0, read: 0, exists: 0, failures: 0 };
    /** Count the call, and count a raise as a failure without swallowing it. */
    const tally = async <T>(
        kind: 'grep' | 'read' | 'exists',
        run: () => Promise<T>,
    ): Promise<T> => {
        stats[kind]++;
        try {
            return await run();
        } catch (err) {
            stats.failures++;
            throw err;
        }
    };

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
        stats,

        get available() {
            return available;
        },
        get unavailableReason() {
            return available ? '' : reason;
        },

        async grep(pattern: string, path = '.', glob?: string) {
            guard(`grep ${JSON.stringify(pattern)}`);
            return tally('grep', () => remote!.grep(pattern, path, glob));
        },

        async read(path: string, start: number, end: number) {
            guard(`read ${path}`);
            return tally('read', () => remote!.read(path, start, end));
        },

        async exists(path: string) {
            guard(`check whether ${path} exists`);
            const listing = await tally('exists', () =>
                remote!.listDir(parentDirOf(path), 1),
            );
            // A provider reports a broken command as an `Error: ` payload rather
            // than by throwing (the same convention `grep` uses). Parsed as a
            // listing it contains no match, so a failed lookup would answer
            // "not there" — the silence-as-evidence this module exists to stop.
            if (listing.startsWith('Error:')) {
                throw new RepoLookupUnavailableError(
                    `check whether ${path} exists`,
                    listing.slice('Error:'.length).trim(),
                );
            }
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
