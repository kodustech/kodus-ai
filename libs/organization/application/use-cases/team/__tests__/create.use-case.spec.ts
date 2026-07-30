import { ParametersKey } from '@libs/core/domain/enums';

import { CreateTeamUseCase } from '../create.use-case';

describe('CreateTeamUseCase', () => {
    const buildUseCase = (createExecute: jest.Mock) => {
        const teamService = {
            find: jest.fn().mockResolvedValue([]),
            createTeam: jest.fn().mockResolvedValue({
                uuid: 'team-1',
                name: 'team',
                organization: { uuid: 'org-1', name: 'org' },
            }),
        };
        const createOrUpdateParametersUseCase = { execute: createExecute };
        const telemetry = { teamCreated: jest.fn() };

        const useCase = new CreateTeamUseCase(
            teamService as any,
            createOrUpdateParametersUseCase as any,
            telemetry as any,
        );

        return { useCase, teamService, createOrUpdateParametersUseCase };
    };

    it('creates the team with both platform_configs and code_review_config', async () => {
        const execute = jest.fn().mockResolvedValue({ ok: true });
        const { useCase } = buildUseCase(execute);

        await useCase.execute({ teamName: 'team', organizationId: 'org-1' });

        const keys = execute.mock.calls.map((call) => call[0]);
        expect(keys).toContain(ParametersKey.PLATFORM_CONFIGS);
        expect(keys).toContain(ParametersKey.CODE_REVIEW_CONFIG);

        const codeReviewCall = execute.mock.calls.find(
            (call) => call[0] === ParametersKey.CODE_REVIEW_CONFIG,
        );
        expect(codeReviewCall?.[1]).toEqual({
            id: 'global',
            name: 'Global',
            isSelected: true,
            configs: {},
            repositories: [],
        });
    });

    it('retries a transient parameter write failure', async () => {
        // platform_configs succeeds; code_review_config fails once then succeeds.
        const execute = jest
            .fn()
            .mockResolvedValueOnce({ ok: true }) // platform_configs
            .mockRejectedValueOnce(new Error('transient')) // code_review try 1
            .mockResolvedValueOnce({ ok: true }); // code_review try 2
        const { useCase } = buildUseCase(execute);

        const team = await useCase.execute({
            teamName: 'team',
            organizationId: 'org-1',
        });

        expect(team?.uuid).toBe('team-1');
        const codeReviewCalls = execute.mock.calls.filter(
            (call) => call[0] === ParametersKey.CODE_REVIEW_CONFIG,
        );
        expect(codeReviewCalls).toHaveLength(2);
    });

    it('logs and still returns the team when a parameter write keeps failing', async () => {
        const execute = jest
            .fn()
            .mockResolvedValueOnce({ ok: true }) // platform_configs
            .mockRejectedValue(new Error('billing down')); // all code_review tries
        const { useCase } = buildUseCase(execute);
        const loggerErrorSpy = jest.spyOn(useCase['logger'], 'error');

        const team = await useCase.execute({
            teamName: 'team',
            organizationId: 'org-1',
        });

        expect(team?.uuid).toBe('team-1');
        expect(loggerErrorSpy).toHaveBeenCalled();
    });
});
