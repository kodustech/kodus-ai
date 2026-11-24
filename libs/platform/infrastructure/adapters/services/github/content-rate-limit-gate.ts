import { classifyGitHubError } from '@libs/core/workflow/domain/errors/classify-github-error';
import { isRateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';
import { GithubAuthDetail } from '@libs/integrations/domain/authIntegrations/types/github-auth-detail.type';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

/** A bad or far-future header must not silence a tenant for longer. */
const MAX_WINDOW_MS = 60 * 60 * 1000;

/**
 * Remembers, per tenant credential and per process, that GitHub said "rate
 * limited until T", so per-file content reads stop calling GitHub until then.
 * Keys come from `contentRateLimitKey`: GitHub's bucket belongs to the
 * credential, so a reinstalled App or a rotated PAT starts with the gate open.
 *
 * Why: `getRepositoryContentFile` swallows its errors and returns
 * `undefined`, so a caller walking hundreds of files never learns the
 * bucket is exhausted. In production one 2,371-file PR fired ~1,370
 * requests in 30s after GitHub had already answered `retryAfter=1272s`,
 * each one failing and logging the whole pull request, on the worker event
 * loop. Inside the window those requests can only fail the same way, so
 * skipping them returns the same `undefined` without the calls and logs.
 */
export class ContentRateLimitGate {
    private readonly blockedUntil = new Map<string, number>();
    private readonly notifiedUntil = new Map<string, number>();

    // Resolved per call (not `= Date.now`), so it reads the same clock
    // classifyGitHubError uses to compute a retry-after deadline.
    constructor(private readonly now: () => number = () => Date.now()) {}

    /**
     * Whether `error` says the credential's primary bucket is empty
     * (`x-ratelimit-remaining: 0`). Every other read with this credential
     * fails the same way until the reset. A secondary (burst) limit is not
     * this: another request, such as the base-ref fallback, can succeed.
     */
    isBucketExhausted(error: unknown): boolean {
        const classified = classifyGitHubError(error);
        return isRateLimitError(classified) && classified.remaining === 0;
    }

    /**
     * Records the window when `error` is a GitHub rate limit (primary or
     * secondary). No key — the credential could not be identified — records
     * nothing, so an unknown credential never gates the tenant's others.
     */
    record(tenant: string | undefined, error: unknown): void {
        if (!tenant) {
            return;
        }
        const classified = classifyGitHubError(error);
        if (!isRateLimitError(classified)) {
            return;
        }

        const now = this.now();
        this.dropExpired(now);
        const until = Math.min(
            classified.resetAt.getTime(),
            now + MAX_WINDOW_MS,
        );
        if (Number.isFinite(until) && until > now) {
            const current = this.blockedUntil.get(tenant) ?? 0;
            this.blockedUntil.set(tenant, Math.max(current, until));
        }
    }

    /** Milliseconds until the tenant may call again; 0 when open or unkeyed. */
    blockedForMs(tenant: string | undefined): number {
        if (!tenant) {
            return 0;
        }
        const until = this.blockedUntil.get(tenant);
        if (until === undefined) {
            return 0;
        }
        const remaining = until - this.now();
        if (remaining <= 0) {
            this.blockedUntil.delete(tenant);
            this.notifiedUntil.delete(tenant);
            return 0;
        }
        return remaining;
    }

    /** True once per window, so a skipped burst logs a single line. */
    firstSkipInWindow(tenant: string): boolean {
        const until = this.blockedUntil.get(tenant);
        if (until === undefined || this.notifiedUntil.get(tenant) === until) {
            return false;
        }
        this.notifiedUntil.set(tenant, until);
        return true;
    }

    /** @internal tests only */
    reset(): void {
        this.blockedUntil.clear();
        this.notifiedUntil.clear();
    }

    // A key orphaned by a reinstall or rotated token is never read again, so
    // expired windows are swept here (only on a rate-limit event).
    private dropExpired(now: number): void {
        for (const [tenant, until] of this.blockedUntil) {
            if (until <= now) {
                this.blockedUntil.delete(tenant);
                this.notifiedUntil.delete(tenant);
            }
        }
    }
}

/** One gate per process, shared by every GithubService instance. */
export const contentRateLimitGate = new ContentRateLimitGate();

/**
 * Gate key: the tenant plus the credential whose rate-limit bucket GitHub
 * reports, mirroring how `instanceOctokit` picks the credential.
 *
 *  - GitHub App (`authMode` OAUTH with an installation): the installation
 *    id. A reinstall gets a new id, so a fresh bucket is never gated by the
 *    old one's window.
 *  - Token (PAT, or OAuth without an installation — the token path in
 *    `instanceOctokit`): the stored credential row id plus its last write.
 *    Rotating the token rewrites the row (TypeORM bumps `updatedAt`); a
 *    reconnect creates a new row. Nothing derived from the token is used.
 *    Another write to the row only opens the gate early: the next read gets
 *    the 403 again and closes it.
 *
 * Undefined when neither identifies the credential (for instance the auth
 * lookup failed and returned a bare `{ authMode }`): the caller then skips
 * the gate entirely rather than gating the whole tenant under one key.
 */
export const contentRateLimitKey = (
    organizationAndTeamData?: { organizationId?: string; teamId?: string },
    authDetail?: Pick<
        GithubAuthDetail,
        'authMode' | 'installationId' | 'authIntegrationId' | 'authUpdatedAt'
    > | null,
): string | undefined => {
    const tenant = `${organizationAndTeamData?.organizationId ?? 'no-org'}:${organizationAndTeamData?.teamId ?? 'no-team'}`;

    if (authDetail?.authMode === AuthMode.OAUTH && authDetail.installationId) {
        return `${tenant}:app:${authDetail.installationId}`;
    }

    const row = authDetail?.authIntegrationId;
    if (!row) {
        return undefined;
    }
    const writtenAt = toIsoOrUndefined(authDetail?.authUpdatedAt);
    return `${tenant}:token:${row}:${writtenAt ?? 'no-date'}`;
};

// The same instant compares equal whether it arrives as a Date (TypeORM) or
// as an ISO string (a serialized copy).
function toIsoOrUndefined(value?: Date | string): string | undefined {
    if (!value) {
        return undefined;
    }
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}
