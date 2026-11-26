import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { OrganizationParametersKey } from '@libs/core/domain/enums';

import { UpdateAuthorFiltersUseCase } from './update-author-filters.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const build = (opts: { known?: boolean; restricted?: string[] } = {}) => {
    const organizationParametersService = {
        mergeConfigValue: jest.fn().mockResolvedValue(undefined),
    };
    const connectionAccess = {
        connectionInOrganization: jest
            .fn()
            .mockResolvedValue(opts.known ?? true),
        restrictionFor: jest
            .fn()
            .mockResolvedValue(
                opts.restricted
                    ? { connectionIds: new Set(opts.restricted) }
                    : null,
            ),
    };
    const useCase = new UpdateAuthorFiltersUseCase(
        organizationParametersService as any,
        connectionAccess as any,
    );
    return { useCase, organizationParametersService };
};

const user = { uuid: 'u-1', organization: { uuid: 'org-1' } };

describe('UpdateAuthorFiltersUseCase', () => {
    it("writes only the named connection's lists, merged into the stored value", async () => {
        const { useCase, organizationParametersService } = build();

        await useCase.execute({
            user,
            connectionId: 'gl-b',
            ignoredUsers: ['7'],
            allowedUsers: [],
        });

        expect(
            organizationParametersService.mergeConfigValue,
        ).toHaveBeenCalledWith(
            OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
            'org-1',
            { ignoredUsers: ['7'], allowedUsers: [] },
            { connectionId: 'gl-b' },
        );
    });

    it("writes the organization's lists when no connection is named", async () => {
        const { useCase, organizationParametersService } = build();

        await useCase.execute({ user, ignoredUsers: [], allowedUsers: ['3'] });

        expect(
            organizationParametersService.mergeConfigValue,
        ).toHaveBeenCalledWith(
            OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
            'org-1',
            { ignoredUsers: [], allowedUsers: ['3'] },
            {},
        );
    });

    it('refuses a connection of another organization, or one the member is not granted', async () => {
        const unknown = build({ known: false });
        await expect(
            unknown.useCase.execute({
                user,
                connectionId: 'elsewhere',
                ignoredUsers: [],
                allowedUsers: [],
            }),
        ).rejects.toBeInstanceOf(NotFoundException);

        const restricted = build({ restricted: ['gh-a'] });
        await expect(
            restricted.useCase.execute({
                user,
                connectionId: 'gl-b',
                ignoredUsers: [],
                allowedUsers: [],
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(
            unknown.organizationParametersService.mergeConfigValue,
        ).not.toHaveBeenCalled();
        expect(
            restricted.organizationParametersService.mergeConfigValue,
        ).not.toHaveBeenCalled();
    });

    it("refuses the organization's lists to a member granted only some connections", async () => {
        const { useCase } = build({ restricted: ['gh-a'] });

        await expect(
            useCase.execute({ user, ignoredUsers: [], allowedUsers: [] }),
        ).rejects.toBeInstanceOf(ForbiddenException);
    });
});
