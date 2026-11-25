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
        });

    const isList = (route: string) =>
        /issues\/\{issue_number\}\/artifacts$/.test(route);

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
        expect(unreadOf(result) ?? []).toEqual([]);
        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(
            'GET /repos/{owner}/{repo}/issues/{issue_number}/artifacts',
            expect.objectContaining({
                owner: 'acme',
                repo: 'web',
                issue_number: 12,
                per_page: 100,
            }),
        );
    });

    it('sends the preview API version and a timeout only on the artifact call', async () => {
        const { service, request } = serviceWith(issue(), () => [
            item(1, 'qa.md', 'Returns 422.'),
        ]);
        await get(service);
        expect(request).toHaveBeenCalledTimes(1);
        const [, params] = request.mock.calls[0];
        expect(params.headers).toMatchObject({
            'X-GitHub-Api-Version': API_VERSION,
        });
        expect(params.request.signal).toBeInstanceOf(AbortSignal);
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
        expect(request).toHaveBeenCalledTimes(1);
        const [route, params] = request.mock.calls[0];
        expect(isList(route)).toBe(true);
        expect(params).toMatchObject({ owner: 'acme', repo: 'web' });
        expect(JSON.stringify(params)).not.toContain('other');
    });

    it.each([403, 500])(
        'still returns the issue and flags the list as unread on a %s',
        async (status) => {
            const { service } = serviceWith(issue(), () => {
                throw httpError(status);
            });
            const result = await get(service);
            expect(result?.number).toBe(12);
            expect(artifactsOf(result) ?? []).toEqual([]);
            expect(unreadOf(result)).toEqual([
                expect.objectContaining({ reason: 'list_failed', status }),
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
        expect(unreadOf(result)).toEqual([
            expect.objectContaining({ reason: 'list_failed' }),
        ]);
    });

    it('treats a 404 on the artifact list as no artifacts: no note', async () => {
        const { service } = serviceWith(issue(), () => {
            throw httpError(404);
        });
        const result = await get(service);
        expect(result?.number).toBe(12);
        expect(artifactsOf(result) ?? []).toEqual([]);
        expect(unreadOf(result) ?? []).toEqual([]);
    });

    it('treats a list that is not an array as unread', async () => {
        const { service } = serviceWith(issue(), () => ({
            unexpected: 'shape',
        }));
        const result = await get(service);
        expect(unreadOf(result)).toEqual([
            expect.objectContaining({ reason: 'invalid_payload' }),
        ]);
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
            expect.objectContaining({ number: 2, name: 'empty.md' }),
            expect.objectContaining({ name: 'bad.md' }),
            expect.objectContaining({ number: 4, name: 'nobody.md' }),
        ]);
    });

    it('says there may be more artifacts when the page is full', async () => {
        const { service } = serviceWith(issue(), () =>
            Array.from({ length: 100 }, (_, i) =>
                item(i + 1, `a${i + 1}.md`, `Rule ${i + 1}.`),
            ),
        );
        const result = await get(service);
        expect(artifactsOf(result)).toHaveLength(100);
        expect(unreadOf(result)).toEqual([
            expect.objectContaining({ reason: 'may_have_more' }),
        ]);
    });

    it('leaves an issue without artifacts as it is', async () => {
        const { service } = serviceWith(issue(), () => []);
        const result = await get(service);
        expect(result?.number).toBe(12);
        expect(artifactsOf(result) ?? []).toEqual([]);
        expect(unreadOf(result) ?? []).toEqual([]);
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
