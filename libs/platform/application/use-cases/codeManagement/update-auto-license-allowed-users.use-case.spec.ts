import { UpdateAutoLicenseAllowedUsersUseCase } from './update-auto-license-allowed-users.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

describe('UpdateAutoLicenseAllowedUsersUseCase', () => {
    it('adds the current user without dropping the rest of the stored settings', async () => {
        const stored = {
            enabled: true,
            ignoredUsers: ['bot-1'],
            allowedUsers: ['5'],
            seededBotIds: ['bot-1'],
            manuallyAssignedIds: ['9'],
            pendingRevocations: { '3': '2026-11-01T00:00:00.000Z' },
            connections: { 'gl-b': { ignoredUsers: ['bot-gl'] } },
        };
        const organizationParametersService = {
            findByKey: jest.fn().mockResolvedValue({ configValue: stored }),
            createOrUpdateConfig: jest.fn().mockResolvedValue(true),
        };
        const codeManagementService = {
            getCurrentUser: jest.fn().mockResolvedValue({ id: 42 }),
        };
        const useCase = new UpdateAutoLicenseAllowedUsersUseCase(
            organizationParametersService as any,
            codeManagementService as any,
        );

        await useCase.execute({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        });

        expect(
            organizationParametersService.createOrUpdateConfig.mock.calls[0][1],
        ).toEqual({ ...stored, allowedUsers: ['5', '42'] });
    });
});
