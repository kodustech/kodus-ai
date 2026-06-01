export const TRIAL_RATE_LIMITER_SERVICE_TOKEN = Symbol.for(
    'TrialRateLimiterService',
);

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt?: Date;
}

/**
 * Rate limiting for trial (unauthenticated) CLI reviews, keyed by a
 * device fingerprint. Implemented by the cache-backed
 * TrialRateLimiterService in the infrastructure layer; consumers inject
 * via TRIAL_RATE_LIMITER_SERVICE_TOKEN and depend on this interface, not
 * the concrete class.
 */
export interface ITrialRateLimiterService {
    checkRateLimit(fingerprint: string): Promise<RateLimitResult>;
    getRateLimitStatus(fingerprint: string): Promise<RateLimitResult>;
}
