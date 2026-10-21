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
