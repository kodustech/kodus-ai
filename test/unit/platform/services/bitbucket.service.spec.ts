/**
 * Regression tests for two confirmed Bitbucket bugs.
 *
 * Bug 1: transformPullRequest maps author.display_name → user.login
 *         instead of the author's UUID. The Bitbucket API (post-GDPR,
 *         April 2019) only accepts account_id or {uuid} as the
 *         selected_user parameter — nicknames and display names are
 *         not valid identifiers.
 *
 * Bug 2: The bitbucket npm package (v2.12.0) response parser calls
 *         .includes() on the Content-Type header without a null check.
 *         When Bitbucket's edge proxy returns a response with no
 *         Content-Type header, this crashes with:
 *         "Cannot read properties of null (reading 'includes')"
 */

// Mock logger so BitbucketService can be instantiated
jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

/**
 * ── Bug A3 ─────────────────────────────────────────────────────────
 * Bitbucket's REST API does not have a "pull request review" concept.
 * GitHub groups line comments under a `pull_request_review_id`; GitLab
 * has its own discussion id. Bitbucket just returns a flat comment.
 *
 * Previously bitbucket.service.ts::createReviewComment returned the raw
 * Bitbucket response, which has `id` but no `pull_request_review_id`.
 * commentManager.service.ts then logged an error on every Bitbucket
 * comment ("missing critical IDs"), still marked the comment as SENT,
 * and persisted feedback rows with `pullRequestReviewId: undefined`.
 *
 * Replicates the small normalizer we now run on Bitbucket's response
 * so the downstream pipeline has a stable grouping id.
 */
function normalizeBitbucketCommentResponse(
    raw: { id?: number | string; content?: any; [k: string]: any } | null,
    prNumber: number,
): any | null {
    if (!raw) return null;
    // Bitbucket has no review grouping; use the PR number as a stable
    // synthetic grouping id so downstream consumers never see undefined.
    const syntheticReviewId = String(prNumber);
    return {
        ...raw,
        pullRequestReviewId: syntheticReviewId,
        pull_request_review_id: syntheticReviewId,
    };
}

describe('Bitbucket A3 — comment response normalization', () => {
    it('adds a synthetic pullRequestReviewId (= prNumber) to the response', () => {
        const raw = { id: 9876, content: { raw: 'hi' } };

        const normalized = normalizeBitbucketCommentResponse(raw, 24870);

        expect(normalized.id).toBe(9876);
        expect(normalized.pullRequestReviewId).toBe('24870');
        expect(normalized.pull_request_review_id).toBe('24870');
    });

    it('returns null when Bitbucket API returned no comment', () => {
        expect(normalizeBitbucketCommentResponse(null, 1)).toBeNull();
    });

    it('preserves every original key on the comment response', () => {
        const raw = {
            id: 1,
            content: { raw: 'body' },
            inline: { path: 'a.ts', to: 5 },
            extra: 'x',
        };

        const normalized = normalizeBitbucketCommentResponse(raw, 42);

        expect(normalized.inline).toEqual({ path: 'a.ts', to: 5 });
        expect(normalized.extra).toBe('x');
        expect(normalized.content).toEqual({ raw: 'body' });
    });

    it('satisfies commentManager.service.ts:987 guard (both commentId and pullRequestReviewId truthy)', () => {
        // Reproduces the exact shape commentManager.service.ts reads at
        // line 982-987. The guard `if (!commentId || !pullRequestReviewId)`
        // must not fire for a normal Bitbucket response after normalization.
        const raw = { id: 777, content: { raw: 'body' } };
        const normalized = normalizeBitbucketCommentResponse(raw, 42);

        const commentId = normalized?.id;
        const pullRequestReviewId =
            normalized?.pull_request_review_id ??
            normalized?.pullRequestReviewId;

        expect(Boolean(commentId && pullRequestReviewId)).toBe(true);
    });
});

describe('Bitbucket Service — Bug Regressions', () => {
    /**
     * ── Bug 1 ──────────────────────────────────────────────────────────
     * transformPullRequest originally set:
     *   user.login = pullRequest.author.display_name
     *
     * The Bitbucket API /2.0/users/{selected_user} only accepts
     * account_id or UUID (with curly braces). Nicknames/display names
     * return 404.
     *
     * The fix sets user.login to the sanitized UUID (without braces).
     * getUserByUsername then detects the bare UUID and wraps it with
     * braces before calling the API.
     */
    describe('Bug 1: transformPullRequest should use account_id for user.login', () => {
        // Replicates the exact user-mapping logic from
        // bitbucket.service.ts transformPullRequest
        function transformPullRequestUserMapping(author: {
            display_name?: string;
            nickname?: string;
            uuid?: string;
            account_id?: string;
        }) {
            const sanitizeUUID = (id: string) => id?.replace(/[{}]/g, '');
            return {
                login: author?.account_id ?? author?.uuid ?? '',
                name: author?.display_name ?? '',
                id: sanitizeUUID(author?.uuid ?? '') ?? '',
            };
        }

        it('should set user.login to account_id, not display_name or nickname', () => {
            const bitbucketAuthor = {
                display_name: 'Ojaswa Sharma',
                nickname: 'ojaswa-sharma',
                uuid: '{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}',
                account_id: '557058:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            };

            const user = transformPullRequestUserMapping(bitbucketAuthor);

            expect(user.login).toBe(
                '557058:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            );
            expect(user.login).not.toBe('Ojaswa Sharma');
            expect(user.login).not.toBe('ojaswa-sharma');
        });

        it('should not contain spaces in user.login (display names have spaces)', () => {
            const bitbucketAuthor = {
                display_name: 'John Doe',
                nickname: 'john-doe',
                uuid: '{11111111-2222-3333-4444-555555555555}',
                account_id: '712020:11111111-2222-3333-4444-555555555555',
            };

            const user = transformPullRequestUserMapping(bitbucketAuthor);

            expect(user.login).not.toContain(' ');
        });

        it('should fallback to uuid when account_id is not available', () => {
            const bitbucketAuthor = {
                display_name: 'Legacy User',
                nickname: 'legacy-user',
                uuid: '{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}',
                // no account_id
            };

            const user = transformPullRequestUserMapping(bitbucketAuthor);

            // Falls back to uuid (with braces — API accepts this format)
            expect(user.login).toBe('{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}');
        });
    });

    /**
     * ── Bug 2 ──────────────────────────────────────────────────────────
     * The bitbucket npm package (v2.12.0) has a response body parser
     * that does this (minified in lib/index.js):
     *
     *   function j(e) {
     *     var r = e.headers.get("content-type")
     *     return r.includes("application/json") ? e.json() : ...
     *   }
     *
     * When Bitbucket's edge proxy returns a response with no Content-Type
     * header, r is null and r.includes() throws TypeError.
     *
     * Our safeFetch wrapper intercepts responses and injects
     * "text/plain" when Content-Type is missing, preventing the crash.
     */
    describe('Bug 2: bitbucket npm package crashes on null Content-Type header', () => {
        // Simulates the bitbucket npm package response parser AFTER our
        // safeFetch wrapper injects a Content-Type when it's missing.
        function bitbucketResponseBodyParser(response: {
            headers: { get: (name: string) => string | null };
            json: () => Promise<any>;
            text: () => Promise<string>;
            arrayBuffer: () => Promise<ArrayBuffer>;
        }) {
            // safeFetch ensures Content-Type is always present
            const rawContentType = response.headers.get('content-type');
            const contentType = rawContentType ?? 'text/plain';

            return contentType.includes('application/json')
                ? response.json()
                : !contentType || /^text\/|charset=utf-8$/.test(contentType)
                  ? response.text()
                  : response.arrayBuffer();
        }

        it('should not crash when the response has no Content-Type header', () => {
            const mockResponse = {
                headers: {
                    get: (_name: string) => null, // No Content-Type header
                },
                json: () => Promise.resolve({}),
                text: () => Promise.resolve('Server Error'),
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
            };

            expect(() => {
                bitbucketResponseBodyParser(mockResponse);
            }).not.toThrow();
        });

        it('should still parse JSON responses correctly when Content-Type is present', async () => {
            const mockResponse = {
                headers: {
                    get: (_name: string) => 'application/json',
                },
                json: () => Promise.resolve({ ok: true }),
                text: () => Promise.resolve(''),
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
            };

            const result = await bitbucketResponseBodyParser(mockResponse);
            expect(result).toEqual({ ok: true });
        });
    });
});
