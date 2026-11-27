import { GithubService } from './github.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

/** getIssue carries the parent and sub-issues GitHub links an issue to. */
describe('GithubService.getIssue: parent and sub-issues', () => {
    const repository = { owner: 'acme', name: 'web' };
    const issue = (extra: Record<string, unknown>) => ({
        id: 1,
        number: 12,
        title: 'Bulk archive',
        body: 'Archive part of the parent.',
        state: 'open',
        html_url: 'https://github.com/acme/web/issues/12',
        created_at: '2026-10-15T00:00:00Z',
        updated_at: '2026-10-15T00:00:00Z',
        ...extra,
    });

    function serviceWith(data: Record<string, unknown>, subIssues?: unknown[]) {
        const request = jest.fn().mockResolvedValue({ data: subIssues ?? [] });
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

    it('names the parent from parent_issue_url, and lists nothing it has none of', async () => {
        const { service, request } = serviceWith(
            issue({
                parent_issue_url:
                    'https://api.github.com/repos/acme/web/issues/11',
                sub_issues_summary: { total: 0 },
            }),
        );
        const result = await get(service);
        expect(result?.parent).toEqual({ number: 11, repository: 'acme/web' });
        expect(result?.subIssues).toBeUndefined();
        expect(request).not.toHaveBeenCalled();
    });

    it('lists the sub-issues only when the summary says there are some', async () => {
        const { service, request } = serviceWith(
            issue({ sub_issues_summary: { total: 1 } }),
            [{ number: 13, title: 'Row checkboxes', state: 'closed' }],
        );
        const result = await get(service);
        expect(result?.subIssues).toEqual([
            { number: 13, title: 'Row checkboxes', state: 'closed' },
        ]);
        expect(result?.parent).toBeUndefined();
        expect(request).toHaveBeenCalledWith(
            'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues',
            expect.objectContaining({
                owner: 'acme',
                repo: 'web',
                issue_number: 12,
            }),
        );
    });

    it('still returns the issue when listing its sub-issues fails', async () => {
        const { service, request } = serviceWith(
            issue({ sub_issues_summary: { total: 2 } }),
        );
        request.mockRejectedValueOnce(new Error('502'));
        const result = await get(service);
        expect(result?.number).toBe(12);
        expect(result?.subIssues).toBeUndefined();
    });
});
