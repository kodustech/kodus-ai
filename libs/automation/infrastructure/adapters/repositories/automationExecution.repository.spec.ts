import { AutomationExecutionRepository } from './automationExecution.repository';

describe('AutomationExecutionRepository.findLatestExecutionByFilters', () => {
    const makeRepository = () => {
        const queryBuilder = {
            andWhere: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            getOne: jest.fn().mockResolvedValue(null),
        };
        const repository = new AutomationExecutionRepository({
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        } as any);
        return { repository, queryBuilder };
    };

    it('matches any of the values when a filter is a list', async () => {
        const { repository, queryBuilder } = makeRepository();

        await repository.findLatestExecutionByFilters({
            status: ['success', 'partial_error'],
        });

        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            'automation_execution.status IN (:...status)',
            { status: ['success', 'partial_error'] },
        );
    });

    it('keeps equality for a single value and for an entity reference', async () => {
        const { repository, queryBuilder } = makeRepository();

        await repository.findLatestExecutionByFilters({
            status: 'success',
            teamAutomation: { uuid: 'team-automation-1' },
        });

        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            'automation_execution.status = :status',
            { status: 'success' },
        );
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            'automation_execution.teamAutomation = :teamAutomation',
            { teamAutomation: 'team-automation-1' },
        );
    });
});

describe('AutomationExecutionRepository.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId', () => {
    it('marks only PRs with a saved scope decision as zero-comment candidates', async () => {
        const subQuery = {
            select: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getQuery: jest.fn().mockReturnValue('(SELECT 1)'),
        };
        const queryBuilder = {
            subQuery: jest.fn().mockReturnValue(subQuery),
            select: jest.fn().mockReturnThis(),
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            groupBy: jest.fn().mockReturnThis(),
            addGroupBy: jest.fn().mockReturnThis(),
            setParameters: jest.fn().mockReturnThis(),
            getRawMany: jest.fn().mockResolvedValue([
                {
                    repositoryId: 'repo-1',
                    pullRequestNumber: '7',
                    mayAllowNoComments: true,
                },
                {
                    repositoryId: 'repo-1',
                    pullRequestNumber: '8',
                    mayAllowNoComments: null,
                },
            ]),
        };
        const repository = new AutomationExecutionRepository({
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        } as any);

        await expect(
            repository.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId(
                new Date('2026-10-01'),
                new Date('2026-10-08'),
                'team-automation-1',
            ),
        ).resolves.toEqual([
            {
                repositoryId: 'repo-1',
                pullRequestNumber: 7,
                mayAllowNoComments: true,
            },
            {
                repositoryId: 'repo-1',
                pullRequestNumber: 8,
                mayAllowNoComments: false,
            },
        ]);
        expect(queryBuilder.addSelect).toHaveBeenCalledWith(
            expect.stringContaining("'approvalDecision'->>'kind'"),
            'mayAllowNoComments',
        );
        expect(queryBuilder.setParameters).toHaveBeenCalledWith(
            expect.objectContaining({
                allowNoCommentKinds: ['approve', 'out-of-scope'],
            }),
        );
    });
});
