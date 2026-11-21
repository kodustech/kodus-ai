// The download token of the Kody Runtime cell (ADR-002, ADR-052): a GitHub
// App installation token for one repository, contents:read only. GitHub fixes
// the lifetime of an installation token at 1 h and takes no shorter one, so
// 1 h is the shortest lifetime there is.

/** The only permissions the token may carry. GitHub adds metadata:read to every installation token. */
export const DOWNLOAD_TOKEN_PERMISSIONS = { contents: 'read' } as const;

const TOLERATED_IMPLICIT = { metadata: 'read' } as const;

export type RepositoryDownloadTokenErrorReason =
    /** PAT / token auth: a personal token cannot be narrowed to one repository. */
    | 'unsupported_auth'
    /** No GitHub App installation for the org and team. */
    | 'no_installation'
    | 'invalid_repository_id'
    /** GitHub answered with a token wider than asked (or no token); it is never returned. */
    | 'unexpected_scope';

export class RepositoryDownloadTokenError extends Error {
    constructor(
        readonly reason: RepositoryDownloadTokenErrorReason,
        message: string,
    ) {
        super(message);
        this.name = 'RepositoryDownloadTokenError';
    }
}

export interface RepositoryDownloadToken {
    token: string;
    /** ISO time GitHub gave; 1 h after minting. */
    expiresAt: string;
}

/** The numeric GitHub id of a repository, or null when `value` is not one. */
export function numericRepositoryId(value: unknown): number | null {
    const text = String(value ?? '').trim();
    if (!/^[1-9]\d*$/.test(text)) return null;
    const id = Number(text);
    return Number.isSafeInteger(id) ? id : null;
}

/**
 * Why the answer of `POST /app/installations/{id}/access_tokens` is not the
 * token that was asked for, or null when it is exactly that: one token, for
 * that one repository, with contents:read and nothing else beyond GitHub's
 * implicit metadata:read.
 */
export function downloadTokenProblem(
    data: unknown,
    repositoryId: number,
): string | null {
    if (!data || typeof data !== 'object') return 'empty response';
    const body = data as Record<string, unknown>;
    if (typeof body.token !== 'string' || body.token.length === 0) {
        return 'no token in the response';
    }
    if (
        typeof body.expires_at !== 'string' ||
        Number.isNaN(Date.parse(body.expires_at))
    ) {
        return 'no expiry in the response';
    }
    if (
        body.repository_selection !== undefined &&
        body.repository_selection !== 'selected'
    ) {
        return `repository_selection is ${String(body.repository_selection)}`;
    }
    const repositories = body.repositories;
    if (!Array.isArray(repositories) || repositories.length !== 1) {
        return `the token covers ${Array.isArray(repositories) ? repositories.length : 'unknown'} repositories`;
    }
    if (String((repositories[0] as { id?: unknown })?.id) !== String(repositoryId)) {
        return 'the token covers another repository';
    }
    const permissions = body.permissions;
    if (!permissions || typeof permissions !== 'object') {
        return 'no permissions in the response';
    }
    const allowed: Record<string, string> = {
        ...TOLERATED_IMPLICIT,
        ...DOWNLOAD_TOKEN_PERMISSIONS,
    };
    for (const [name, level] of Object.entries(permissions)) {
        if (allowed[name] !== level) {
            return `unexpected permission ${name}:${String(level)}`;
        }
    }
    if ((permissions as Record<string, unknown>).contents !== 'read') {
        return 'contents:read missing';
    }
    return null;
}

/**
 * A dev stack connected with a PAT may hand the Runtime that PAT as its
 * download token (RUNTIME_DEV_ALLOW_PAT_DOWNLOAD=true): it is NOT scoped to the
 * repository, so this is refused whenever the process runs as production
 * (NODE_ENV=production, the production image, or cloud mode).
 */
export function devPatDownloadAllowed(env: Record<string, string | undefined>): boolean {
    if (env.RUNTIME_DEV_ALLOW_PAT_DOWNLOAD !== 'true') return false;
    if (env.NODE_ENV === 'production' || env.RUNTIME_PRODUCTION_IMAGE === '1' || env.API_CLOUD_MODE === 'true') return false;
    return true;
}
