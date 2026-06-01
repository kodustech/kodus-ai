import { classifyGitHubError } from '@libs/core/workflow/domain/errors/classify-github-error';
import { RateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';

describe('classifyGitHubError', () => {
    it('converts a 403 primary-rate-limit response (remaining=0 + reset header)', () => {
        const reset = Math.floor(Date.now() / 1000) + 47 * 60;
        const err = {
            status: 403,
            response: {
                status: 403,
                headers: {
                    'x-ratelimit-remaining': '0',
                    'x-ratelimit-reset': String(reset),
                },
            },
            message: 'API rate limit exceeded',
        };

        const result = classifyGitHubError(err);
        expect(result).toBeInstanceOf(RateLimitError);
        const rl = result as RateLimitError;
        expect(rl.resetAt.getTime()).toBe(reset * 1000);
        expect(rl.remaining).toBe(0);
    });

    it('converts a 429 with retry-after header (secondary rate-limit)', () => {
        const err = {
            status: 429,
            response: {
                headers: { 'retry-after': '60' },
            },
            message: 'You have triggered an abuse detection mechanism',
        };

        const result = classifyGitHubError(err);
        expect(result).toBeInstanceOf(RateLimitError);
        const rl = result as RateLimitError;
        // resetAt should be ~now + 60s
        const expected = Date.now() + 60 * 1000;
        expect(Math.abs(rl.resetAt.getTime() - expected)).toBeLessThan(2000);
    });

    it('converts a 403 with retry-after even when ratelimit headers are missing', () => {
        const err = {
            status: 403,
            response: {
                headers: { 'retry-after': '30' },
            },
        };
        const result = classifyGitHubError(err);
        expect(result).toBeInstanceOf(RateLimitError);
    });

    it('passes through 403 errors that are not rate-limit shaped', () => {
        const err = {
            status: 403,
            response: { headers: { something: 'else' } },
            message: 'Forbidden — permission denied',
        };
        const result = classifyGitHubError(err);
        expect(result).toBe(err);
        expect(result).not.toBeInstanceOf(RateLimitError);
    });

    it('passes through 401, 404, 500, etc unchanged', () => {
        for (const status of [401, 404, 422, 500, 502, 503]) {
            const err = { status, response: { headers: {} } };
            expect(classifyGitHubError(err)).toBe(err);
        }
    });

    it('passes through completely unrelated errors', () => {
        const err = new TypeError('something broke');
        expect(classifyGitHubError(err)).toBe(err);

        expect(classifyGitHubError(null)).toBe(null);
        expect(classifyGitHubError(undefined)).toBe(undefined);
        expect(classifyGitHubError('string')).toBe('string');
    });

    it('handles malformed ratelimit reset header gracefully', () => {
        const err = {
            status: 403,
            response: {
                headers: {
                    'x-ratelimit-remaining': '0',
                    'x-ratelimit-reset': 'not-a-number',
                },
            },
        };
        // Falls through (no retry-after either) → returned as-is.
        const result = classifyGitHubError(err);
        expect(result).toBe(err);
    });

    it('reads headers from both response.headers and top-level headers', () => {
        const reset = Math.floor(Date.now() / 1000) + 60;
        const err = {
            status: 403,
            headers: {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(reset),
            },
        };
        expect(classifyGitHubError(err)).toBeInstanceOf(RateLimitError);
    });
});
