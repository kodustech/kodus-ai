import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { AutomationExecutionEntity } from '@libs/automation/domain/automationExecution/entities/automation-execution.entity';

import { AutomationExecutionRepository } from './automationExecution.repository';

const makeRepository = () => {
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
        orderBy: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        setParameters: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
        getMany: jest.fn().mockResolvedValue([]),
        getRawMany: jest.fn().mockResolvedValue([]),
    };
    const typeormRepository = {
        createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        find: jest.fn().mockResolvedValue([]),
    };
    const repository = new AutomationExecutionRepository(
        typeormRepository as any,
    );
    return { repository, queryBuilder, subQuery, typeormRepository };
};

describe('AutomationExecutionRepository.findLatestExecutionByFilters', () => {
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

    it('returns the most recent match as an entity', async () => {
        const { repository, queryBuilder } = makeRepository();
        queryBuilder.getOne.mockResolvedValueOnce({
            uuid: 'execution-newest',
            createdAt: new Date('2025-06-11T10:00:00Z'),
            status: AutomationStatus.SUCCESS,
        });

        const result = await repository.findLatestExecutionByFilters({
            status: AutomationStatus.SUCCESS,
        });

        expect(queryBuilder.orderBy).toHaveBeenCalledWith(
            'automation_execution.createdAt',
            'DESC',
        );
        expect(result).toBeInstanceOf(AutomationExecutionEntity);
        expect(result.uuid).toBe('execution-newest');
    });
});

describe('AutomationExecutionRepository.find', () => {
    it('passes compound filters through and loads the execution relations', async () => {
        const { repository, typeormRepository } = makeRepository();
        const filter = {
            teamAutomation: { uuid: 'team-automation-1' },
            pullRequestNumber: 123,
            repositoryId: 'repo-1',
            status: AutomationStatus.IN_PROGRESS,
        };

        await repository.find(filter as any);

        expect(typeormRepository.find).toHaveBeenCalledWith(
            expect.objectContaining({
                where: filter,
                relations: expect.arrayContaining([
                    'teamAutomation',
                    'codeReviewExecutions',
                ]),
            }),
        );
    });
});

describe('AutomationExecutionRepository.findByPeriodAndTeamAutomationId', () => {
    const start = new Date('2026-03-01T00:00:00.000Z');
    const end = new Date('2026-03-08T00:00:00.000Z');

    it('uses IN for a list of statuses and equality for a single one', async () => {
        const list = makeRepository();
        await list.repository.findByPeriodAndTeamAutomationId(
            start,
            end,
            'team-automation-1',
            [AutomationStatus.SUCCESS, AutomationStatus.IN_PROGRESS],
        );
        expect(list.queryBuilder.andWhere).toHaveBeenCalledWith(
            'automation_execution.status IN (:...statuses)',
            {
                statuses: [
                    AutomationStatus.SUCCESS,
                    AutomationStatus.IN_PROGRESS,
                ],
            },
        );

        const single = makeRepository();
        await single.repository.findByPeriodAndTeamAutomationId(
            start,
            end,
            'team-automation-1',
            AutomationStatus.SUCCESS,
        );
        expect(single.queryBuilder.andWhere).toHaveBeenCalledWith(
            'automation_execution.status = :status',
            { status: AutomationStatus.SUCCESS },
        );
    });
});

describe('AutomationExecutionRepository.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId', () => {
    it('excludes in-progress pairs, drops invalid refs and marks only scope-decided PRs as zero-comment candidates', async () => {
        const { repository, queryBuilder, subQuery } = makeRepository();
        queryBuilder.getRawMany.mockResolvedValue([
            {
                repositoryId: 'repo-1',
                pullRequestNumber: '7',
                mayAllowNoComments: true,
            },
            {
                repositoryId: 'repo-1',
                pullRequestNumber: 8,
                mayAllowNoComments: null,
            },
            { repositoryId: '', pullRequestNumber: '56' },
            { repositoryId: 'repo-c', pullRequestNumber: 'NaN' },
        ]);

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

        // The in-progress exclusion is not bounded by the period.
        expect(subQuery.where).toHaveBeenCalledWith(
            'in_progress.team_automation_id = :teamAutomationId',
        );
        expect(subQuery.where).not.toHaveBeenCalledWith(
            expect.stringContaining('createdAt BETWEEN'),
        );
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            expect.stringContaining('NOT EXISTS'),
        );
        expect(queryBuilder.addSelect).toHaveBeenCalledWith(
            expect.stringContaining("'approvalDecision'->>'kind'"),
            'mayAllowNoComments',
        );
        expect(queryBuilder.setParameters).toHaveBeenCalledWith(
            expect.objectContaining({
                teamAutomationId: 'team-automation-1',
                successStatus: AutomationStatus.SUCCESS,
                inProgressStatus: AutomationStatus.IN_PROGRESS,
                allowNoCommentKinds: ['approve', 'hold', 'out-of-scope'],
            }),
        );
    });
});
