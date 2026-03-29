import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { AutomationExecutionRepository } from '@libs/automation/infrastructure/adapters/repositories/automationExecution.repository';

describe('AutomationExecutionRepository', () => {
    const makeRepository = () => {
        const subQueryBuilder = {
            select: jest.fn().mockReturnThis(),
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            getQuery: jest.fn().mockReturnValue('(SELECT 1)'),
        };

        const queryBuilder = {
            subQuery: jest.fn().mockReturnValue(subQueryBuilder),
            select: jest.fn().mockReturnThis(),
            addSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            groupBy: jest.fn().mockReturnThis(),
            addGroupBy: jest.fn().mockReturnThis(),
            setParameters: jest.fn().mockReturnThis(),
            getMany: jest.fn().mockResolvedValue([]),
            getRawMany: jest.fn().mockResolvedValue([]),
        };

        const typeormRepository = {
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
            find: jest.fn().mockResolvedValue([]),
        } as any;

        const repository = new AutomationExecutionRepository(typeormRepository);

        return {
            repository,
            typeormRepository,
            queryBuilder,
            subQueryBuilder,
        };
    };

    it('uses IN clause when status is an array in findByPeriodAndTeamAutomationId', async () => {
        const { repository, queryBuilder } = makeRepository();

        await repository.findByPeriodAndTeamAutomationId(
            new Date('2026-03-01T00:00:00.000Z'),
            new Date('2026-03-08T00:00:00.000Z'),
            'team-automation-1',
            [AutomationStatus.SUCCESS, AutomationStatus.IN_PROGRESS],
        );

        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            'automation_execution.status IN (:...statuses)',
            {
                statuses: [
                    AutomationStatus.SUCCESS,
                    AutomationStatus.IN_PROGRESS,
                ],
            },
        );
    });

    it('uses equals clause when status is a single value in findByPeriodAndTeamAutomationId', async () => {
        const { repository, queryBuilder } = makeRepository();

        await repository.findByPeriodAndTeamAutomationId(
            new Date('2026-03-01T00:00:00.000Z'),
            new Date('2026-03-08T00:00:00.000Z'),
            'team-automation-1',
            AutomationStatus.SUCCESS,
        );

        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            'automation_execution.status = :status',
            {
                status: AutomationStatus.SUCCESS,
            },
        );
    });

    it('passes compound filters through find (including nested relation filters)', async () => {
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

    it('returns eligible pull request refs excluding in-progress pairs using DB query', async () => {
        const { repository, queryBuilder, subQueryBuilder } = makeRepository();

        queryBuilder.getRawMany.mockResolvedValue([
            { repositoryId: 'repo-a', pullRequestNumber: '12' },
            { repositoryId: 'repo-b', pullRequestNumber: 34 },
            { repositoryId: '', pullRequestNumber: '56' },
            { repositoryId: 'repo-c', pullRequestNumber: 'NaN' },
        ]);

        const result =
            await repository.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId(
                new Date('2026-03-01T00:00:00.000Z'),
                new Date('2026-03-08T00:00:00.000Z'),
                'team-automation-1',
            );

        expect(queryBuilder.subQuery).toHaveBeenCalled();
        expect(subQueryBuilder.where).toHaveBeenCalledWith(
            'in_progress.team_automation_id = :teamAutomationId',
        );
        expect(subQueryBuilder.where).not.toHaveBeenCalledWith(
            expect.stringContaining(
                'createdAt BETWEEN :startDate AND :endDate',
            ),
        );
        expect(queryBuilder.andWhere).toHaveBeenCalledWith(
            expect.stringContaining('NOT EXISTS'),
        );
        expect(queryBuilder.setParameters).toHaveBeenCalledWith(
            expect.objectContaining({
                teamAutomationId: 'team-automation-1',
                successStatus: AutomationStatus.SUCCESS,
                inProgressStatus: AutomationStatus.IN_PROGRESS,
            }),
        );

        expect(result).toEqual([
            { repositoryId: 'repo-a', pullRequestNumber: 12 },
            { repositoryId: 'repo-b', pullRequestNumber: 34 },
        ]);
    });
});
