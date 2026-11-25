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
    const listItem = (number: number, name: string) => ({ number, name });
    const detail = (number: number, name: string, body: string, v = 1) => ({
        artifact: { number, name },
        versions: [{ version: v, name, body }],
        has_next_page: false,
        total_count: 1,
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
    const isDetail = (route: string) =>
        /issues\/\{issue_number\}\/artifacts\/\{[a-z_]+\}$/.test(route);

    const artifactsOf = (result: unknown) =>
        (result as { artifacts?: any[] } | null)?.artifacts;
    const unreadOf = (result: unknown) =>
        (result as { unreadArtifacts?: any[] } | null)?.unreadArtifacts;

    it('lists the artifacts of the issue and reads the current version of each', async () => {
        const { service, request } = serviceWith(issue(), (route, params) => {
            if (isList(route)) {
                return [listItem(1, 'qa.md'), listItem(2, 'product.md')];
            }
            if (Object.values(params).includes(1)) {
                return {
                    artifact: { number: 1, name: 'qa.md' },
                    versions: [
                        {
                            version: 3,
                            name: 'qa.md',
                            body: 'Returns 422 (v3).',
                        },
                        {
                            version: 2,
                            name: 'qa.md',
                            body: 'Returns 400 (v2).',
                        },
                    ],
                    has_next_page: false,
                    total_count: 2,
                };
            }
            return detail(2, 'product.md', 'Sign up by email.');
        });
        const result = await get(service);
        expect(artifactsOf(result)).toEqual([
            expect.objectContaining({ number: 1, name: 'qa.md', version: 3 }),
            expect.objectContaining({
                number: 2,
                name: 'product.md',
                version: 1,
            }),
        ]);
        expect(JSON.stringify(artifactsOf(result))).toContain(
            'Returns 422 (v3).',
        );
        expect(JSON.stringify(artifactsOf(result))).not.toContain(
            'Returns 400 (v2).',
        );
        expect(unreadOf(result) ?? []).toEqual([]);
        expect(request).toHaveBeenCalledWith(
            expect.stringMatching(
                /^GET \/repos\/\{owner\}\/\{repo\}\/issues\/\{issue_number\}\/artifacts$/,
            ),
            expect.objectContaining({
                owner: 'acme',
                repo: 'web',
                issue_number: 12,
            }),
        );
    });

    it('sends the preview API version only on the artifact calls', async () => {
        const { service, request } = serviceWith(issue(), (route) =>
            isList(route)
                ? [listItem(1, 'qa.md')]
                : detail(1, 'qa.md', 'Returns 422.'),
        );
        await get(service);
        const artifactCalls = request.mock.calls.filter(
            ([route]) => isList(route) || isDetail(route),
        );
        expect(artifactCalls.length).toBeGreaterThanOrEqual(2);
        for (const [, params] of artifactCalls) {
            expect(params.headers).toMatchObject({
                'X-GitHub-Api-Version': API_VERSION,
            });
        }
    });

    it('does not call the artifacts API for any repository but the issue own', async () => {
        const { service, request } = serviceWith(
            issue({
                body: [
                    'See https://github.com/other/secret/issues/5/artifacts/1',
                    'and https://example.com/spec.md',
                ].join('\n'),
            }),
            (route) => (isList(route) ? [] : null),
        );
        const fetchSpy = jest.spyOn(globalThis, 'fetch' as any);
        try {
            await get(service);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
        }
        const artifactCalls = request.mock.calls.filter(
            ([route]) => isList(route) || isDetail(route),
        );
        expect(artifactCalls.length).toBeGreaterThanOrEqual(1);
        for (const [, params] of artifactCalls) {
            expect(params).toMatchObject({ owner: 'acme', repo: 'web' });
            expect(JSON.stringify(params)).not.toContain('other');
        }
    });

    it.each([403, 404, 500])(
        'still returns the issue, naming the artifact it could not read, on a %s',
        async (status) => {
            const { service } = serviceWith(issue(), (route, params) => {
                if (isList(route)) {
                    return [listItem(1, 'product.md'), listItem(2, 'qa.md')];
                }
                if (Object.values(params).includes(2)) {
                    throw httpError(status);
                }
                return detail(1, 'product.md', 'Sign up by email.');
            });
            const result = await get(service);
            expect(result?.number).toBe(12);
            expect(artifactsOf(result)).toEqual([
                expect.objectContaining({ number: 1, name: 'product.md' }),
            ]);
            expect(unreadOf(result)).toEqual([
                expect.objectContaining({ number: 2, name: 'qa.md' }),
            ]);
        },
    );

    it('treats a 404 on the artifact list as no artifacts: no note', async () => {
        const { service } = serviceWith(issue(), (route) => {
            if (isList(route)) {
                throw httpError(404);
            }
            return null;
        });
        const result = await get(service);
        expect(result?.number).toBe(12);
        expect(artifactsOf(result) ?? []).toEqual([]);
        expect(unreadOf(result) ?? []).toEqual([]);
    });

    it.each([403, 500])(
        'still returns the issue when listing the artifacts fails with %s',
        async (status) => {
            const { service } = serviceWith(issue(), (route) => {
                if (isList(route)) {
                    throw httpError(status);
                }
                return null;
            });
            const result = await get(service);
            expect(result?.number).toBe(12);
            expect(artifactsOf(result) ?? []).toEqual([]);
            expect((unreadOf(result) ?? []).length).toBeGreaterThanOrEqual(1);
        },
    );

    it('treats an invalid artifact payload as unread, never as content', async () => {
        const { service } = serviceWith(issue(), (route) => {
            if (isList(route)) {
                return [listItem(1, 'qa.md')];
            }
            return { unexpected: 'shape' };
        });
        const result = await get(service);
        expect(result?.number).toBe(12);
        expect(artifactsOf(result) ?? []).toEqual([]);
        expect(unreadOf(result)).toEqual([
            expect.objectContaining({ number: 1 }),
        ]);
    });

    it('leaves an issue without artifacts as it is', async () => {
        const { service } = serviceWith(issue(), (route) =>
            isList(route) ? [] : null,
        );
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
