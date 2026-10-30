import { NotFoundException } from '@nestjs/common';

import { GetCliReviewByIdUseCase } from './get-cli-review-by-id.use-case';

jest.mock('./cli-reviews.mapper', () => ({
    mapExecutionToSummary: (execution: { uuid: string }) => ({
        uuid: execution.uuid,
    }),
}));

describe('GetCliReviewByIdUseCase organization scope', () => {
    // Real repository semantics: `find` applies the organization filter;
    // `findById` returns the execution with no relations loaded.
    const executions = [
        { uuid: 'own', origin: 'cli', organizationId: 'org-own' },
        { uuid: 'foreign', origin: 'cli', organizationId: 'org-other' },
    ];
    const automationExecutionService = {
        find: jest.fn(async (filter: any) =>
            executions.filter(
                (e) =>
                    e.uuid === filter.uuid &&
                    e.organizationId ===
                        filter.teamAutomation?.team?.organization?.uuid,
            ),
        ),
        findById: jest.fn(async (uuid: string) => {
            const e = executions.find((x) => x.uuid === uuid);
            return e ? { uuid: e.uuid, origin: e.origin } : null;
        }),
    };
    const useCase = new GetCliReviewByIdUseCase(
        automationExecutionService as any,
        { findManyByAutomationExecutionIds: jest.fn(async () => []) } as any,
    );

    it('does not return another organization execution', async () => {
        await expect(
            useCase.execute({
                executionUuid: 'foreign',
                organizationId: 'org-own',
            }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns an execution of the caller organization', async () => {
        await expect(
            useCase.execute({ executionUuid: 'own', organizationId: 'org-own' }),
        ).resolves.toEqual(expect.objectContaining({ uuid: 'own' }));
    });
});
