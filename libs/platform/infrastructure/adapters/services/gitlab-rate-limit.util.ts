import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { RateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';

/**
 * gitbeaker already retries 429/502 ten times on its own, but its backoff is
 * `delay(2 ** i * 0.25)` and `delay` takes milliseconds — the whole curve adds
 * up to ~256ms. So by the time `GitbeakerRetryError` surfaces, GitLab has
 * refused eleven requests in a quarter of a second. That is a hard "stop
 * pushing" signal, not a per-request hiccup, and retrying it ourselves would
 * only deepen the hole.
 *
 * 502 raises the same error and is not literally rate limiting, but a GitLab
 * answering 502 to a burst wants the same treatment.
 */
const GITBEAKER_RETRY_ERROR_NAME = 'GitbeakerRetryError';

/**
 * GitLab's default rate-limit window. We cannot read the real `Retry-After`:
 * gitbeaker discards the response when it gives up and only keeps the status
 * code inside the error message.
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
    return new RateLimitError({
        resetAt: new Date(Date.now() + GITLAB_RATE_LIMIT_WINDOW_MS),
        message: `GitLab refused the request rate: ${
            (error as Error)?.message ?? 'unknown error'
        }`,
        context: {
            organizationId: organizationAndTeamData?.organizationId,
            teamId: organizationAndTeamData?.teamId,
        },
    });
}
