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
    describe('KODUS_GET_ISSUE output with GitHub issue artifacts', () => {
        const base = {
            id: '1',
            number: 7,
            title: 'Signup form validation',
            body: 'Acceptance criteria: see qa.md (artifact #1)',
            state: 'open' as const,
            url: 'https://github.com/acme/web/issues/7',
            labels: [],
            assignees: [],
            author: null,
            createdAt: '2026-10-01T00:00:00Z',
            updatedAt: '2026-10-01T00:00:00Z',
            closedAt: null,
            platform: PlatformType.GITHUB,
        };
        const schema = () => (tools.getIssue() as any).outputSchema;

        it('accepts an issue without artifacts, as before', () => {
            expect(
                schema().safeParse({ success: true, data: base }).success,
            ).toBe(true);
        });

        it('accepts an optional artifacts field', () => {
            const parsed = schema().safeParse({
                success: true,
                data: {
                    ...base,
                    artifacts: [
                        {
                            number: 1,
                            name: 'qa.md',
                            content: '- An empty form returns 422.',
                        },
                    ],
                },
            });
            expect(parsed.error?.issues ?? []).toEqual([]);
            expect(parsed.success).toBe(true);
        });

        it('passes includeArtifacts on to the facade, and only when given', async () => {
            mockCodeManagementService.getIssue.mockResolvedValue(base as any);
            const args = {
                organizationId: 'org',
                teamId: 'team',
                repository: { owner: 'acme', name: 'web' },
                issueNumber: 7,
            };
            await tools
                .getIssue()
                .execute({ ...args, includeArtifacts: true } as any);
            await tools.getIssue().execute(args as any);
            const [withFlag, without] =
                mockCodeManagementService.getIssue.mock.calls.map(([p]) => p);
            expect(withFlag).toMatchObject({ includeArtifacts: true });
            expect(without.includeArtifacts).toBeUndefined();
        });

        it('returns the artifacts the facade read, untouched', async () => {
            const artifacts = [
                {
                    number: 1,
                    name: 'qa.md',
                    content: 'Returns 422.',
                },
            ];
            mockCodeManagementService.getIssue.mockResolvedValue({
                ...base,
                artifacts,
            } as any);

            const result = await tools.getIssue().execute({
                organizationId: 'org',
                teamId: 'team',
                repository: { owner: 'acme', name: 'web' },
                issueNumber: 7,
            } as any);

            expect((result as any).structuredContent.data.artifacts).toEqual(
                artifacts,
            );
            expect(
                schema().safeParse((result as any).structuredContent).success,
            ).toBe(true);
        });
    });
});
