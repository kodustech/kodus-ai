import {
    RateLimitError,
    isRateLimitError,
} from '@libs/core/workflow/domain/errors/rate-limit.error';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';

describe('RateLimitError + isRateLimitError', () => {
    it('builds with required fields', () => {
        const resetAt = new Date(Date.now() + 60_000);
        const err = new RateLimitError({ resetAt, remaining: 0 });
        expect(err).toBeInstanceOf(Error);
        expect(err.resetAt).toBe(resetAt);
        expect(err.remaining).toBe(0);
        expect(err.errorClassification).toBe(ErrorClassification.RATE_LIMITED);
    });

    it('isRateLimitError recognizes real instances', () => {
        const err = new RateLimitError({ resetAt: new Date() });
        expect(isRateLimitError(err)).toBe(true);
    });

    it('isRateLimitError recognizes plain objects with the right shape', () => {
        const plain = {
            errorClassification: ErrorClassification.RATE_LIMITED,
            resetAt: new Date(),
        };
        expect(isRateLimitError(plain)).toBe(true);
    });

    it('isRateLimitError returns false for null and undefined', () => {
        expect(isRateLimitError(null)).toBe(false);
        expect(isRateLimitError(undefined)).toBe(false);
    });

    it('isRateLimitError returns false for objects missing resetAt', () => {
        expect(
            isRateLimitError({
                errorClassification: ErrorClassification.RATE_LIMITED,
            }),
        ).toBe(false);
    });

    it('isRateLimitError returns false when resetAt is not a Date (e.g. JSON-rehydrated string)', () => {
        // After AMQP roundtrip the value may come back stringified — the
        // guard MUST be strict about this so the consumer doesn't compute
        // delays from a NaN getTime().
        expect(
            isRateLimitError({
                errorClassification: ErrorClassification.RATE_LIMITED,
                resetAt: '2026-01-01T00:00:00Z',
            }),
        ).toBe(false);
    });

    it('isRateLimitError returns false for unrelated errors', () => {
        expect(isRateLimitError(new Error('boom'))).toBe(false);
        expect(isRateLimitError(new TypeError('x'))).toBe(false);
        expect(isRateLimitError('rate limit string')).toBe(false);
        expect(isRateLimitError(42)).toBe(false);
    });

    it('preserves context (org/team/installation) for downstream logging', () => {
        const err = new RateLimitError({
            resetAt: new Date(),
            context: { organizationId: 'o', teamId: 't' },
        });
        expect(err.context).toEqual({ organizationId: 'o', teamId: 't' });
    });
});
