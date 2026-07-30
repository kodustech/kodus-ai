import { Test, TestingModule } from '@nestjs/testing';

import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { KodusIssuesTools } from './kodusIssues.tools';

describe('KodusIssuesTools', () => {
    let tools: KodusIssuesTools;
    let mockCodeManagementService: jest.Mocked<
        Pick<CodeManagementService, 'listIssues' | 'getIssue'>
    >;

    beforeEach(async () => {
        mockCodeManagementService = {
            listIssues: jest.fn(),
            getIssue: jest.fn(),
        } as any;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KodusIssuesTools,
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
            ],
        }).compile();

        tools = module.get<KodusIssuesTools>(KodusIssuesTools);
    });

    it('exposes both generic issue tools', () => {
        expect(tools.getAllTools().map((tool) => tool.name)).toEqual([
            'KODUS_LIST_ISSUES',
            'KODUS_GET_ISSUE',
        ]);
    });

    it('lists issues via the code-management facade', async () => {
        const issue = {
            id: '1',
            number: 42,
            title: 'Issue title',
            body: null,
            state: 'open' as const,
            url: 'https://github.com/kodustech/kodus-ai/issues/42',
            labels: ['bug'],
            assignees: ['John'],
            author: null,
            createdAt: '2026-03-01T00:00:00Z',
            updatedAt: '2026-03-01T00:00:00Z',
            closedAt: null,
            platform: PlatformType.GITHUB,
        };
        mockCodeManagementService.listIssues.mockResolvedValue([issue]);

        const result = await tools.listIssues().execute({
            organizationId: 'org',
            teamId: 'team',
            repository: { owner: 'kodustech', name: 'kodus-ai' },
        } as any);

        expect(mockCodeManagementService.listIssues).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org',
                    teamId: 'team',
                },
                repository: { owner: 'kodustech', name: 'kodus-ai' },
            }),
        );
        expect((result as any).structuredContent).toEqual({
            success: true,
            count: 1,
            data: [issue],
        });
    });

    it('returns null data when the issue is not found', async () => {
        mockCodeManagementService.getIssue.mockResolvedValue(null);

        const result = await tools.getIssue().execute({
            organizationId: 'org',
            teamId: 'team',
            repository: { owner: 'kodustech', name: 'kodus-ai' },
            issueNumber: 999,
        } as any);

        expect(mockCodeManagementService.getIssue).toHaveBeenCalledWith(
            expect.objectContaining({ issueNumber: 999 }),
        );
        expect((result as any).structuredContent).toEqual({
            success: true,
            data: null,
        });
    });
});
