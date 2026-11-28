import { GithubService } from './github.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

/**
 * getIssue carries the artifacts GitHub attaches to an issue (public preview,
 * REST API version 2026-03-10). All content here is synthetic.
 */
describe('GithubService.getIssue: issue artifacts', () => {
    const repository = { owner: 'acme', name: 'web' };
    const API_VERSION = '2026-03-10';
    const issue = (extra: Record<string, unknown> = {}) => ({
        id: 1,
        number: 12,
        title: 'Signup form validation',
        body: 'Acceptance criteria: see qa.md (artifact #1)',
        state: 'open',
        html_url: 'https://github.com/acme/web/issues/12',
        created_at: '2026-10-15T00:00:00Z',
        updated_at: '2026-10-15T00:00:00Z',
        ...extra,
    });
    const item = (number: number, name: string, body: string) => ({
        number,
        name,
        body,
        updated_at: '2026-11-25T00:00:00Z',
    });
    const httpError = (status: number) =>
        Object.assign(new Error(`HTTP ${status}`), { status });

    type Handler = (route: string, params: Record<string, any>) => unknown;

    function serviceWith(data: Record<string, unknown>, handler: Handler) {
        const request = jest.fn(async (route: string, params: any) => {
            const result = await handler(route, params);
            return { data: result };
        });
        const octokit = {
            rest: { issues: { get: jest.fn().mockResolvedValue({ data }) } },
            request,
        };
        const service = Object.create(GithubService.prototype) as GithubService;
        (service as any).getAuthenticatedOctokit = async () => octokit;
        return { service, request };
    }

    const get = (service: GithubService) =>
        service.getIssue({
            organizationAndTeamData: { organizationId: 'org-1' },
            repository,
            issueNumber: 12,
            includeArtifacts: true,
        });

    const TIMEOUT_MS = 10_000;
    const signal = new AbortController().signal;
    let timeoutSpy: jest.SpyInstance;
    beforeEach(() => {
        timeoutSpy = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    });
    afterEach(() => {
        timeoutSpy.mockRestore();
    });

    /** The one call the artifact list is read with, in full. */
    const LIST_CALL = [
        'GET /repos/{owner}/{repo}/issues/{issue_number}/artifacts',
        {
            owner: 'acme',
            repo: 'web',
            issue_number: 12,
            per_page: 100,
            headers: { 'X-GitHub-Api-Version': API_VERSION },
            request: { signal },
        },
    ];

    const artifactsOf = (result: unknown) =>
        (result as { artifacts?: any[] } | null)?.artifacts;
    const unreadOf = (result: unknown) =>
        (result as { unreadArtifacts?: any[] } | null)?.unreadArtifacts;

    it('reads the artifacts of the issue from the list endpoint alone', async () => {
        const { service, request } = serviceWith(issue(), () => [
            item(1, 'qa.md', 'Returns 422.'),
            item(2, 'product.md', 'Sign up by email.'),
        ]);
        const result = await get(service);
        expect(artifactsOf(result)).toEqual([
            { number: 1, name: 'qa.md', content: 'Returns 422.' },
            { number: 2, name: 'product.md', content: 'Sign up by email.' },
        ]);
        expect(unreadOf(result)).toBeUndefined();
        expect(request.mock.calls).toEqual([LIST_CALL]);
        expect(timeoutSpy).toHaveBeenCalledWith(TIMEOUT_MS);
    });

    it('does not call the artifacts API for any repository but the issue own', async () => {
        const { service, request } = serviceWith(
            issue({
                body: [
                    'See https://github.com/other/secret/issues/5/artifacts/1',
                    'and https://example.com/spec.md',
                ].join('\n'),
            }),
            () => [],
        );
        const fetchSpy = jest.spyOn(globalThis, 'fetch' as any);
        try {
            await get(service);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
        }
        expect(request.mock.calls).toEqual([LIST_CALL]);
    });

    it.each([403, 500])(
        'still returns the issue and flags the list as unread on a %s',
        async (status) => {
            const { service } = serviceWith(issue(), () => {
                throw httpError(status);
            });
            const result = await get(service);
            expect(result?.number).toBe(12);
            expect(artifactsOf(result)).toBeUndefined();
            expect(unreadOf(result)).toEqual([
                { reason: 'list_failed', status },
            ]);
        },
    );

    it('flags the list as unread when the request times out', async () => {
        const { service } = serviceWith(issue(), () => {
            throw Object.assign(new Error('The operation timed out'), {
                name: 'TimeoutError',
            });
        });
        const result = await get(service);
        expect(result?.number).toBe(12);
        expect(unreadOf(result)).toEqual([{ reason: 'list_failed' }]);
    });

    it('flags a 404 on the artifact list as unavailable, not as no artifacts', async () => {
        const { service } = serviceWith(issue(), () => {
            throw httpError(404);
        });
        const result = await get(service);
        expect(result?.number).toBe(12);
        expect(artifactsOf(result)).toBeUndefined();
        expect(unreadOf(result)).toEqual([
            { reason: 'not_found', status: 404 },
        ]);
    });

    it.each([
        ['a 429', httpError(429)],
        [
            'a 403 with no quota left',
            Object.assign(httpError(403), {
                response: { headers: { 'x-ratelimit-remaining': '0' } },
            }),
        ],
        [
            'a 403 with a retry-after header (secondary rate limit)',
            Object.assign(httpError(403), {
                response: { headers: { 'retry-after': '60' } },
            }),
        ],
    ])(
        'rethrows %s, as getIssue does for the issue itself',
        async (_label, error) => {
            const { service } = serviceWith(issue(), () => {
                throw error;
            });
            await expect(get(service)).rejects.toBe(error);
        },
    );

    it('does not trust a message that claims a secondary rate limit', async () => {
        const { service } = serviceWith(issue(), () => {
            throw Object.assign(
                new Error('You have exceeded a secondary rate limit'),
                { status: 403 },
            );
        });
        const result = await get(service);
        expect(unreadOf(result)).toEqual([
            { reason: 'list_failed', status: 403 },
        ]);
    });

    it('still reports a 403 with quota left as unread', async () => {
        const { service } = serviceWith(issue(), () => {
            throw Object.assign(httpError(403), {
                response: { headers: { 'x-ratelimit-remaining': '42' } },
            });
        });
        const result = await get(service);
        expect(unreadOf(result)).toEqual([
            { reason: 'list_failed', status: 403 },
        ]);
    });

    it('treats a list that is not an array as unread', async () => {
        const { service } = serviceWith(issue(), () => ({
            unexpected: 'shape',
        }));
        const result = await get(service);
        expect(unreadOf(result)).toEqual([{ reason: 'invalid_payload' }]);
    });

    it('names an invalid or empty item as unread and keeps the valid ones', async () => {
        const { service } = serviceWith(issue(), () => [
            item(1, 'qa.md', 'Returns 422.'),
            item(2, 'empty.md', '   '),
            { number: 'three', name: 'bad.md', body: 'x' },
            { number: 4, name: 'nobody.md' },
        ]);
        const result = await get(service);
        expect(artifactsOf(result)).toEqual([
            { number: 1, name: 'qa.md', content: 'Returns 422.' },
        ]);
        expect(unreadOf(result)).toEqual([
            { number: 2, name: 'empty.md', reason: 'invalid_payload' },
            { name: 'bad.md', reason: 'invalid_payload' },
            { number: 4, name: 'nobody.md', reason: 'invalid_payload' },
        ]);
    });

    it('says there may be more artifacts when the page is full', async () => {
        const { service } = serviceWith(issue(), () =>
            Array.from({ length: 100 }, (_, i) =>
                item(i + 1, `a${i + 1}.md`, `Rule ${i + 1}.`),
            ),
        );
        const result = await get(service);
        expect(artifactsOf(result)).toEqual(
            Array.from({ length: 100 }, (_, i) => ({
                number: i + 1,
                name: `a${i + 1}.md`,
                content: `Rule ${i + 1}.`,
            })),
        );
        expect(unreadOf(result)).toEqual([{ reason: 'may_have_more' }]);
    });

    it('makes no artifact call unless the caller asks for them', async () => {
        const { service, request } = serviceWith(issue(), () => [
            item(1, 'qa.md', 'Returns 422.'),
        ]);
        const result = await service.getIssue({
            organizationAndTeamData: { organizationId: 'org-1' },
            repository,
            issueNumber: 12,
        });
        expect(result?.number).toBe(12);
        expect(artifactsOf(result)).toBeUndefined();
        expect(unreadOf(result)).toBeUndefined();
        expect(request).not.toHaveBeenCalled();
    });

    it('leaves an issue without artifacts as it is', async () => {
        const { service } = serviceWith(issue(), () => []);
        const result = await get(service);
        expect(result?.number).toBe(12);
        expect(artifactsOf(result)).toBeUndefined();
        expect(unreadOf(result)).toBeUndefined();
    });

    it('does not read artifacts of a pull request', async () => {
        const { service, request } = serviceWith(
            issue({ pull_request: { url: 'https://api.github.com/x' } }),
            () => [],
        );
        expect(await get(service)).toBeNull();
        expect(request).not.toHaveBeenCalled();
    });
});
