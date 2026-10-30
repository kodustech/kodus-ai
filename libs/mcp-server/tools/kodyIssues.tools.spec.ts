import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import { LabelType } from '@libs/common/utils/codeManagement/labels';

import { KodyIssuesTools } from './kodyIssues.tools';

describe('KodyIssuesTools organization scope', () => {
    const issues = [
        { uuid: 'own-issue', organizationId: 'org-1' },
        { uuid: 'foreign-issue', organizationId: 'victim-org' },
    ];
    const issuesService = {
        // Real repository: lookup by Mongo _id, no organization filter.
        findById: jest.fn(
            async (id: string) =>
                issues.find((issue) => issue.uuid === id) ?? null,
        ),
        findOne: jest.fn(async () => {
            throw new Error('findOne({ uuid }) never matches an issue');
        }),
        updateStatus: jest.fn(async (uuid: string) => ({ uuid })),
        updateLabel: jest.fn(async (uuid: string) => ({ uuid })),
    };
    const tools = new KodyIssuesTools(issuesService as any, {} as any);

    // organizationId is what McpToolAuthorizer injects from the credential.
    const calls = {
        status: (issueId: string, organizationId?: string) =>
            tools.updateKodyIssueStatus().execute({
                issueId,
                organizationId,
                status: IssueStatus.RESOLVED,
            }),
        category: (issueId: string, organizationId?: string) =>
            tools.updateKodyIssueCategory().execute({
                issueId,
                organizationId,
                label: Object.values(LabelType)[0],
            }),
        dismiss: (issueId: string, organizationId?: string) =>
            tools.deleteKodyIssue().execute({ issueId, organizationId }),
        details: (issueId: string, organizationId?: string) =>
            tools.getKodyIssueDetails().execute({ issueId, organizationId }),
    };

    beforeEach(() => jest.clearAllMocks());

    it.each(Object.keys(calls))(
        '%s does not touch an issue of another organization',
        async (name) => {
            const result: any = await calls[name]('foreign-issue', 'org-1');
            expect(result.structuredContent.success).toBe(false);
            expect(result.structuredContent.data ?? null).toBeNull();
            expect(issuesService.updateStatus).not.toHaveBeenCalled();
            expect(issuesService.updateLabel).not.toHaveBeenCalled();
        },
    );

    it.each(Object.keys(calls))(
        '%s fails closed without an organization',
        async (name) => {
            const result: any = await calls[name]('own-issue');
            expect(result.structuredContent.success).toBe(false);
            expect(issuesService.updateStatus).not.toHaveBeenCalled();
            expect(issuesService.updateLabel).not.toHaveBeenCalled();
        },
    );

    it.each(Object.keys(calls))(
        '%s still works on an issue of the caller organization',
        async (name) => {
            const result: any = await calls[name]('own-issue', 'org-1');
            expect(result.structuredContent.success).toBe(true);
        },
    );
});

describe('KodyIssuesTools listKodyIssues', () => {
    const issuesService = { findByFilters: jest.fn(async () => []) };
    const tools = new KodyIssuesTools(issuesService as any, {} as any);

    beforeEach(() => jest.clearAllMocks());

    it('filters by the stored field repository.name, not repositoryName', async () => {
        await tools.listKodyIssues().execute({
            organizationId: 'org-1',
            repositoryName: 'kodus-ai',
        });

        expect(issuesService.findByFilters).toHaveBeenCalledWith({
            'organizationId': 'org-1',
            'repository.name': 'kodus-ai',
        });
    });

    it('omits the repository filter when no repositoryName is given', async () => {
        await tools.listKodyIssues().execute({ organizationId: 'org-1' });

        expect(issuesService.findByFilters).toHaveBeenCalledWith({
            organizationId: 'org-1',
        });
    });
});
