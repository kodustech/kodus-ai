import { NotFoundException } from '@nestjs/common';
import { CloneIntegrationUseCase } from './clone-integration.use-case';

describe('CloneIntegrationUseCase organization isolation', () => {
    const build = () => {
        const auth = {
            findOne: jest
                .fn()
                .mockResolvedValue({ authDetails: { token: 'source-token' } }),
            create: jest.fn().mockResolvedValue({ uuid: 'auth-new' }),
        };
        const integration = {
            findOne: jest
                .fn()
                .mockResolvedValue({
                    authIntegration: { uuid: 'auth-source' },
                }),
            create: jest.fn().mockResolvedValue({ uuid: 'integration-new' }),
        };
        const teams = {
            findOneOrganizationIdByTeamId: jest.fn(
                async (id: string) =>
                    ({
                        source: 'org-own',
                        destination: 'org-own',
                        foreign: 'org-other',
                    })[id],
            ),
        };
        const request = { user: { organization: { uuid: 'org-own' } } };
        const useCase = new CloneIntegrationUseCase(
            auth as any,
            integration as any,
            request as any,
            teams as any,
        );
        return { useCase, auth, integration };
    };
    const params = {
        teamId: 'destination',
        teamIdClone: 'source',
        integrationData: { platform: 'GITHUB', category: 'CODE_MANAGEMENT' },
    };

    it.each([
        { teamId: 'foreign' },
        { teamIdClone: 'foreign' },
        { teamId: 'missing' },
        { teamIdClone: 'missing' },
    ])('rejects teams outside the organization: %j', async (override) => {
        const { useCase, auth, integration } = build();
        await expect(
            useCase.execute({ ...params, ...override }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(auth.create).not.toHaveBeenCalled();
        expect(integration.create).not.toHaveBeenCalled();
    });

    it('still clones between teams in the caller organization', async () => {
        const { useCase, auth, integration } = build();
        await expect(useCase.execute(params)).resolves.toEqual({
            status: true,
        });
        expect(auth.create).toHaveBeenCalledWith(
            expect.objectContaining({
                organization: { uuid: 'org-own' },
                team: { uuid: 'destination' },
            }),
        );
        expect(integration.create).toHaveBeenCalledWith(
            expect.objectContaining({
                organization: { uuid: 'org-own' },
                team: { uuid: 'destination' },
            }),
        );
    });
});
