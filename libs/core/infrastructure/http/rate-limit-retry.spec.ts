import { RateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';

import { is429Error, isTransientFetchError } from './rate-limit-retry';

/**
 * Regression coverage for the class of bug fixed in
 * "fix(platform): rethrow transient fetch failures from getCommits swallow"
 * (2026-07-29) + its follow-up "fix(http): match undici timeout errors in
 * isTransientFetchError" (2026-07-29): azureRepos.service.ts and
 * bitbucket-cloud.service.ts swallow errors from fetching a PR's commits
 * into `null`, which upstream collapses to "PR has no commits" —
 * createLineComments then anchors zero inline comments and the review
 * ships with suggestionsCount.sent=0, reporting SUCCESS, with the real
 * cause (a transient network failure) never surfaced anywhere. Observed
 * live, 2026-07-29, cloud bitbucket cell.
 *
 * These two classifiers are the ONLY thing standing between "genuinely no
 * commits" and "the fetch failed" for those callers — a regex that's
 * missing a pattern (exactly what happened once already: the first cut of
 * isTransientFetchError missed undici's HeadersTimeout/BodyTimeout/
 * ConnectTimeout variants) silently reintroduces the exact same silent
 * data-loss bug. No test existed for either function before this.
 */
describe('isTransientFetchError', () => {
    const transientCases: Array<[string, unknown]> = [
        ['bare undici "fetch failed"', new TypeError('fetch failed')],
        ['ECONNRESET', { message: 'read ECONNRESET' }],
        ['ECONNREFUSED', { message: 'connect ECONNREFUSED 127.0.0.1:443' }],
        ['ETIMEDOUT', { message: 'connect ETIMEDOUT' }],
        [
            'EAI_AGAIN (DNS blip)',
            { message: 'getaddrinfo EAI_AGAIN api.github.com' },
        ],
        ['socket hang up', { message: 'socket hang up' }],
        ['socket hangup (no space)', { message: 'socket hangup' }],
        ['network error', { message: 'network error occurred' }],
        ['Recv failure', { message: 'Recv failure: Connection reset by peer' }],
        ['operation was aborted', { message: 'The operation was aborted' }],
        ['bare UND_ERR code', { code: 'UND_ERR_SOCKET' }],
        [
            'undici HeadersTimeoutError by name',
            { name: 'HeadersTimeoutError', message: 'Headers Timeout Error' },
        ],
        [
            'undici BodyTimeoutError by name',
            { name: 'BodyTimeoutError', message: 'Body Timeout Error' },
        ],
        [
            'undici ConnectTimeoutError by name',
            { name: 'ConnectTimeoutError', message: 'Connect Timeout Error' },
        ],
        [
            // isTransientFetchError only ever inspects `.message`/`.code`
            // (own + `.cause`) — NEVER `.name` — because undici's timeout
            // errors already carry "Headers Timeout Error" etc. as message
            // prose (see the follow-up fix's commit message). A client
            // whose message text embeds "TimeoutError" (axios-style) still
            // matches; one that only sets `.name` would not.
            'message text embedding "TimeoutError" (axios-style)',
            { message: 'TimeoutError: Response timeout of 30000ms exceeded' },
        ],
        // fetch() wraps the real undici error on .cause, with a generic
        // top-level message — this is the shape that actually reaches
        // application code, not the bare undici error.
        [
            'detail only on .cause (the real fetch() shape)',
            {
                message: 'fetch failed',
                cause: { message: 'ECONNRESET', code: 'ECONNRESET' },
            },
        ],
        [
            '.cause carries the undici error code, not message',
            {
                message: 'fetch failed',
                cause: { code: 'UND_ERR_HEADERS_TIMEOUT' },
            },
        ],
    ];

    it.each(transientCases)('matches: %s', (_label, err) => {
        expect(isTransientFetchError(err)).toBe(true);
    });

    const nonTransientCases: Array<[string, unknown]> = [
        ['undefined', undefined],
        ['null', null],
        ['plain string (not an object)', 'fetch failed'],
        ['a genuine 404 Not Found', { status: 404, message: 'Not Found' }],
        [
            'a validation error unrelated to networking',
            new Error('Invalid repository id'),
        ],
        ['an empty object', {}],
        // The exact ambiguity this function exists to resolve: a caller
        // must NOT treat "the PR really has no commits" as transient just
        // because the message happens to be generic.
        [
            'a business-logic "no commits found" error',
            new Error('No commits found for PR'),
        ],
        // Deliberate: only `.message`/`.code` (own + `.cause`) are
        // inspected, never `.name` — an error that sets ONLY `.name` to
        // something timeout-shaped, with no matching text in the message,
        // does not match. Documented so a future edit doesn't "fix" this by
        // widening the haystack without someone deciding that on purpose.
        [
            '.name alone ("TimeoutError") with unrelated message text',
            { name: 'TimeoutError', message: 'request could not complete' },
        ],
    ];

    it.each(nonTransientCases)('does NOT match: %s', (_label, err) => {
        expect(isTransientFetchError(err)).toBe(false);
    });
});

describe('is429Error', () => {
    const rateLimitedCases: Array<[string, unknown]> = [
        ['status: 429', { status: 429 }],
        ['statusCode: 429', { statusCode: 429 }],
        ['response.status: 429', { response: { status: 429 } }],
        ['response.statusCode: 429', { response: { statusCode: 429 } }],
        [
            'message mentions 429',
            { message: 'Request failed with status code 429' },
        ],
        [
            'message: Too Many Requests (bitbucket SDK shape)',
            { message: 'HTTPError: Too Many Requests' },
        ],
        [
            'name: GitbeakerRetryError (gitlab SDK shape)',
            { name: 'GitbeakerRetryError', message: 'retry exhausted' },
        ],
    ];

    it.each(rateLimitedCases)('matches: %s', (_label, err) => {
        expect(is429Error(err)).toBe(true);
    });

    const notRateLimitedCases: Array<[string, unknown]> = [
        ['undefined', undefined],
        ['status: 500', { status: 500 }],
        ['status: 404', { status: 404 }],
        ['a plain transient fetch failure', new TypeError('fetch failed')],
        [
            'a message containing an unrelated number',
            { message: 'retrying in 4290ms' },
        ],
    ];

    it.each(notRateLimitedCases)('does NOT match: %s', (_label, err) => {
        expect(is429Error(err)).toBe(false);
    });

    /**
     * An adapter may classify the failure itself before it reaches a
     * `with429Retry` caller — GitlabService does this in
     * `getPullRequestReviewComment`, which generate-kody-rules wraps in
     * `with429Retry`. Translating renames the error, so matching on the SDK
     * shape alone silently drops the retry for anything whose original
     * status was not literally 429.
     */
    describe('errors already classified as rate-limited by an adapter', () => {
        it('matches a translated 429', () => {
            expect(
                is429Error(
                    new RateLimitError({
                        resetAt: new Date('2026-08-21T00:01:00.000Z'),
                        message:
                            'GitLab refused the request rate: Could not successfully complete this request after 10 retries, last status code: 429.',
                    }),
                ),
            ).toBe(true);
        });

        it('matches a translated 502, which has no 429 anywhere in it', () => {
            const translated = new RateLimitError({
                resetAt: new Date('2026-08-21T00:01:00.000Z'),
                message:
                    'GitLab refused the request rate: Could not successfully complete this request after 10 retries, last status code: 502.',
            });

            expect(translated.name).toBe('RateLimitError');
            expect(/\b429\b/.test(translated.message)).toBe(false);
            expect(is429Error(translated)).toBe(true);
        });
    });
});
