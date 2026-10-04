import { NotFoundException } from '@nestjs/common';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';

import { AcceptUserInvitationUseCase } from './accept-user-invitation.use-case';

describe('AcceptUserInvitationUseCase', () => {
    const users: Record<string, { uuid: string; status: STATUS }> = {
        invited: { uuid: 'invited', status: STATUS.PENDING },
        signup: { uuid: 'signup', status: STATUS.PENDING },
        active: { uuid: 'active', status: STATUS.ACTIVE },
    };
    // Self sign-ups get a profile at sign-up; invites only when accepted.
    const profiles = new Set(['signup', 'active']);

    const usersService = {
        findOne: jest.fn(async (filter: { uuid: string; status?: STATUS }) => {
            const user = users[filter.uuid];
            return user && (!filter.status || user.status === filter.status)
                ? user
                : null;
        }),
        update: jest.fn(async (filter: { uuid: string }) => ({
            uuid: filter.uuid,
            email: `${filter.uuid}@acme.dev`,
        })),
    };
    const profileService = {
        findOne: jest.fn(async (filter: { user: { uuid: string } }) =>
            profiles.has(filter.user.uuid) ? { uuid: 'p' } : null,
        ),
    };
    const createProfile = { execute: jest.fn() };
    const useCase = new AcceptUserInvitationUseCase(
        usersService as any,
        { hashPassword: jest.fn(async () => 'hash') } as any,
        createProfile as any,
        { userInvitationAccepted: jest.fn() } as any,
        profileService as any,
    );

    const accept = (uuid: string) =>
        useCase.execute({
            uuid,
            name: 'Someone',
            password: 'Str0ngP@ssw0rd!',
        } as any);

    beforeEach(() => jest.clearAllMocks());

    it.each([
        ['an active account', 'active'],
        ['a self sign-up still confirming its email', 'signup'],
        ['an unknown id', 'missing'],
    ])('does not set the password of %s', async (_label, uuid) => {
        await expect(accept(uuid)).rejects.toBeInstanceOf(NotFoundException);
        expect(usersService.update).not.toHaveBeenCalled();
        expect(createProfile.execute).not.toHaveBeenCalled();
    });

    it('completes an open invitation, guarding the update by status', async () => {
        await accept('invited');
        expect(usersService.update).toHaveBeenCalledWith(
            { uuid: 'invited', status: STATUS.PENDING },
            expect.objectContaining({ status: STATUS.ACTIVE }),
        );
        expect(createProfile.execute).toHaveBeenCalled();
    });
});
