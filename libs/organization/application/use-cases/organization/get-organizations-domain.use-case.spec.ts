import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import { GetOrganizationsByDomainUseCase } from './get-organizations-domain.use-case';

describe('GetOrganizationsByDomainUseCase', () => {
    const build = () => {
        const organizationParametersService = {
            findByKeyAndValue: jest.fn().mockResolvedValue([
                {
                    configKey: OrganizationParametersKey.AUTO_JOIN_CONFIG,
                    configValue: { enabled: true, domains: ['acme.dev'] },
                    organization: { uuid: 'org-1' },
                },
            ]),
        };
        const organizationService = {
            findOne: jest.fn().mockResolvedValue({
                uuid: 'org-1',
                name: 'Acme',
                user: [{ role: Role.OWNER, email: 'owner@acme.dev' }],
            }),
        };
        const useCase = new GetOrganizationsByDomainUseCase(
            organizationService as any,
            organizationParametersService as any,
        );
        return { useCase, organizationParametersService };
    };

    it('lists the organizations open to the requester email domain', async () => {
        const { useCase } = build();

        await expect(
            useCase.execute('ACME.dev', 'dev@acme.dev'),
        ).resolves.toEqual([
            { uuid: 'org-1', name: 'Acme', owner: 'owner@acme.dev' },
        ]);
    });

    it.each([
        ['another domain', 'dev@other.dev'],
        ['no requester email', undefined],
    ])(
        'answers a lookup for %s with an empty list',
        async (_label, requesterEmail) => {
            const { useCase, organizationParametersService } = build();

            await expect(
                useCase.execute('acme.dev', requesterEmail as any),
            ).resolves.toEqual([]);
            expect(
                organizationParametersService.findByKeyAndValue,
            ).not.toHaveBeenCalled();
        },
    );
});
