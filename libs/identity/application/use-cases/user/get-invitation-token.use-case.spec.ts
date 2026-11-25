import { NotFoundException } from '@nestjs/common';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { openInvitation } from '@libs/identity/domain/user/invitation-token';

import { GetInvitationTokenUseCase } from './get-invitation-token.use-case';

/**
 * The admin's "copy invite link" gets a fresh token, only for an open
 * invitation of the admin's own organization.
 */
describe('GetInvitationTokenUseCase', () => {
    const cryptoKey = process.env.API_CRYPTO_KEY;
    beforeAll(() => {
        process.env.API_CRYPTO_KEY = 'cd'.repeat(32);
    });
    afterAll(() => {
        process.env.API_CRYPTO_KEY = cryptoKey;
    });

    const users = [
        {
            uuid: 'invited',
            email: 'Invited@acme.dev',
            status: STATUS.PENDING,
            org: 'org-1',
        },
        {
            uuid: 'accepted',
            email: 'a@acme.dev',
            status: STATUS.PENDING,
            org: 'org-1',
        },
        {
            uuid: 'active',
            email: 'b@acme.dev',
            status: STATUS.ACTIVE,
            org: 'org-1',
        },
        {
            uuid: 'elsewhere',
            email: 'c@acme.dev',
            status: STATUS.PENDING,
            org: 'org-2',
        },
    ];
    const usersService = {
        findOne: jest.fn(
            async (f: {
                uuid: string;
                status: STATUS;
                organization: { uuid: string };
            }) =>
                users.find(
                    (u) =>
                        u.uuid === f.uuid &&
                        u.status === f.status &&
                        u.org === f.organization.uuid,
                ) ?? null,
        ),
    };
    const profileService = {
        findOne: jest.fn(async (f: { user: { uuid: string } }) =>
            f.user.uuid === 'accepted' ? { uuid: 'p' } : null,
        ),
    };
    const useCase = new GetInvitationTokenUseCase(
        usersService as any,
        profileService as any,
    );

    it('seals the invitation of a pending member of the organization', async () => {
        const { token } = await useCase.execute('invited', 'org-1');

        expect(openInvitation(token)).toEqual({
            userId: 'invited',
            email: 'invited@acme.dev',
        });
    });

    it.each([
        ['an invitation already accepted', 'accepted', 'org-1'],
        ['an active member', 'active', 'org-1'],
        ['a member of another organization', 'elsewhere', 'org-1'],
        ['a request without an organization', 'invited', ''],
    ])('refuses %s', async (_label, userId, organizationId) => {
        await expect(useCase.execute(userId, organizationId)).rejects.toThrow(
            'No open invitation for this user',
        );
    });

    // TypeORM drops an undefined value from a where clause: looking the user
    // up without both ids would find them in any organization.
    it.each([
        ['without an organization', 'invited', undefined],
        ['without a user', undefined, 'org-1'],
    ])('never looks a user up %s', async (_label, userId, organizationId) => {
        usersService.findOne.mockClear();

        await expect(
            useCase.execute(userId as any, organizationId as any),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(usersService.findOne).not.toHaveBeenCalled();
    });
});
