import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { RateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';

/**
 * `GitbeakerRetryError` is what GitlabService sees when GitLab refuses the
 * request rate: `gitlabRequestHandler` raises it on a 429 (carrying the
 * `Retry-After` wait) instead of gitbeaker's eleven retries in ~250ms. It is a
 * hard "stop pushing" signal, not a per-request hiccup.
 *
 * 502 raises the same error and is not literally rate limiting, but a GitLab
 * answering 502 to a burst wants the same treatment.
 */
const GITBEAKER_RETRY_ERROR_NAME = 'GitbeakerRetryError';

/**
 * GitLab's default rate-limit window, for errors that do not carry the wait.
 * The 429s raised by `gitlabRequestHandler` do (`retryAfterMs`); a 502 that
 * exhausted its retries does not.
 */
const GITLAB_RATE_LIMIT_WINDOW_MS = 60_000;

export function isGitlabRateLimitError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as Error).name === GITBEAKER_RETRY_ERROR_NAME
    );
}

/**
 * Translates the gitbeaker-specific error into the provider-agnostic
 * `RateLimitError`, which `RabbitMQErrorHandler` already recognizes to
 * republish the message with a reset-aligned delay instead of the generic
 * backoff curve.
 */
export function toGitlabRateLimitError(
    error: unknown,
    organizationAndTeamData?: OrganizationAndTeamData,
): RateLimitError {
    const retryAfterMs = (error as { retryAfterMs?: unknown })?.retryAfterMs;
    const waitMs =
        typeof retryAfterMs === 'number' && retryAfterMs > 0
            ? retryAfterMs
            : GITLAB_RATE_LIMIT_WINDOW_MS;
    return new RateLimitError({
        resetAt: new Date(Date.now() + waitMs),
        message: `GitLab refused the request rate: ${
            (error as Error)?.message ?? 'unknown error'
        }`,
        context: {
            organizationId: organizationAndTeamData?.organizationId,
            teamId: organizationAndTeamData?.teamId,
        },
    });
}
