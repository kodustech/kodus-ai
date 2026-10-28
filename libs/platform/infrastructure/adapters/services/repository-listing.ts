import { RepositoryFile } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositoryFile.type';

/**
 * A repository listing that failed, as opposed to one that found nothing.
 * `getRepositoryAllFiles` throws it only when the caller passed
 * `throwOnError`; every other caller keeps getting `[]`.
 */
export class RepositoryListingError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'RepositoryListingError';
    }
}

/**
 * What `getRepositoryAllFiles` returns when it cannot list the repository:
 * `[]`, or a `RepositoryListingError` when the caller asked for one. Callers
 * log before calling it.
 */
export function listingFailed(
    throwOnError: boolean | undefined,
    reason: string,
    cause?: unknown,
): RepositoryFile[] {
    if (!throwOnError) return [];
    if (cause instanceof RepositoryListingError) throw cause;
    throw new RepositoryListingError(reason, { cause });
}
