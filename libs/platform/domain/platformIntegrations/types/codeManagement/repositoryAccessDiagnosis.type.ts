/**
 * Read-only answer to "can Kody work on this repository with the stored
 * credential?", used by the self-hosted doctor (#1987). Every field is
 * produced without writing to the provider: `write` comes from the
 * permission the provider reports for the credential, never from posting.
 *
 * `unknown` means the provider did not tell us, not that it is fine.
 */
export type RepositoryAccessState = 'ok' | 'denied' | 'unknown';

export type RepositoryHookState =
    | 'present'
    | 'missing'
    // GitHub App installs receive events through the app-level webhook, so a
    // missing repository hook is expected there.
    | 'app-level'
    | 'unknown';

export type RepositoryAccessDiagnosis = {
    read: RepositoryAccessState;
    write: RepositoryAccessState;
    hook: RepositoryHookState;
    /** Provider error summary (status code + message). Never a credential. */
    error?: string;
};

export const UNKNOWN_REPOSITORY_ACCESS: RepositoryAccessDiagnosis = {
    read: 'unknown',
    write: 'unknown',
    hook: 'unknown',
};

// Octokit sets `status`, axios `response.status`, gitbeaker v43
// `cause.response.status`.
function providerErrorStatus(error: any): number | undefined {
    const status =
        error?.status ??
        error?.response?.status ??
        error?.cause?.status ??
        error?.cause?.response?.status;
    return status === undefined ? undefined : Number(status);
}

/** Extracts a short, credential-free summary from a provider error. */
export function summarizeProviderError(error: any): string {
    const status = providerErrorStatus(error);
    const message = String(
        error?.response?.data?.message ??
            error?.cause?.description ??
            error?.message ??
            error ??
            'unknown error',
    ).slice(0, 200);
    return status ? `${status} ${message}` : message;
}

export function isDeniedStatus(error: any): boolean {
    const status = providerErrorStatus(error);
    return status === 401 || status === 403 || status === 404;
}
