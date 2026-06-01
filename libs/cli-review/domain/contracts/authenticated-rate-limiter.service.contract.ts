export const AUTHENTICATED_RATE_LIMITER_SERVICE_TOKEN = Symbol.for(
    'AuthenticatedRateLimiterService',
);

export interface AuthenticatedRateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt?: Date;
}

/**
 * Rate limiting for authenticated CLI reviews, keyed by team id.
 * Implemented by the cache-backed AuthenticatedRateLimiterService in the
 * infrastructure layer; consumers inject via
 * AUTHENTICATED_RATE_LIMITER_SERVICE_TOKEN and depend on this interface,
 * not the concrete class.
 */
export interface IAuthenticatedRateLimiterService {
    checkRateLimit(teamId: string): Promise<AuthenticatedRateLimitResult>;
}
