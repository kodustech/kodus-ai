import { PlatformType } from '@libs/core/domain/enums';

import { GetOrganizationLanguageUseCase } from './get-organization-language.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const make = (opts: {
    type: PlatformType | null;
    repositories: Array<Record<string, unknown>>;
}) => {
    const codeManagementService = {
        getTypeIntegration: jest.fn().mockResolvedValue(opts.type),
        getLanguageRepository: jest.fn().mockResolvedValue('TypeScript'),
        getRepositories: jest.fn().mockResolvedValue([]),
    };
    const integrationConfigService = {
        findIntegrationConfigFormatted: jest
            .fn()
            .mockResolvedValue(opts.repositories),
    };
    const useCase = new GetOrganizationLanguageUseCase(
        integrationConfigService as any,
        codeManagementService as any,
        { user: { organization: { uuid: 'org-1' } } } as any,
    );
    return { useCase, codeManagementService };
};

describe('GetOrganizationLanguageUseCase with several Git connections', () => {
    it('asks for the platform of the repository it was given', async () => {
        const { useCase, codeManagementService } = make({
            type: PlatformType.GITLAB,
            repositories: [{ id: '22', name: 'web' }],
        });

        await useCase.execute({ teamId: 'team-1', repositoryId: '22' });

        expect(codeManagementService.getTypeIntegration).toHaveBeenCalledWith(
            { organizationId: 'org-1', teamId: 'team-1' },
            { id: '22' },
        );
    });

    it('still reads the languages when the connections span platforms', async () => {
        const { useCase, codeManagementService } = make({
            type: null,
            repositories: [
                { id: '1', name: 'api' },
                { id: '22', name: 'web' },
            ],
        });

        const result = await useCase.execute({ teamId: 'team-1' });

        expect(result).toEqual({ language: 'TypeScript' });
        expect(
            codeManagementService.getLanguageRepository,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                repository: { id: '22', name: 'web' },
            }),
        );
    });
});
