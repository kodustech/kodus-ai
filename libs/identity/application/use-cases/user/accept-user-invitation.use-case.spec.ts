import { NotFoundException } from '@nestjs/common';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';

import {
    INVITATION_TTL_MS,
    sealInvitation,
} from '@libs/identity/domain/user/invitation-token';

import { AcceptUserInvitationUseCase } from './accept-user-invitation.use-case';

describe('AcceptUserInvitationUseCase', () => {
    const cryptoKey = process.env.API_CRYPTO_KEY;
    beforeAll(() => {
        process.env.API_CRYPTO_KEY = 'cd'.repeat(32);
    });
    afterAll(() => {
        process.env.API_CRYPTO_KEY = cryptoKey;
    });

    const users: Record<
        string,
        { uuid: string; status: STATUS; email: string }
    > = {
        invited: {
            uuid: 'invited',
            status: STATUS.PENDING,
            email: 'invited@acme.dev',
        },
        signup: {
            uuid: 'signup',
            status: STATUS.PENDING,
            email: 'signup@acme.dev',
        },
        active: {
            uuid: 'active',
            status: STATUS.ACTIVE,
            email: 'active@acme.dev',
        },
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
    const telemetry = { userInvitationAccepted: jest.fn() };
    const useCase = new AcceptUserInvitationUseCase(
        usersService as any,
        { hashPassword: jest.fn(async () => 'hash') } as any,
        createProfile as any,
        telemetry as any,
        profileService as any,
    );

    /** The link an invitation email carries for `uuid`. */
    const tokenFor = (uuid: string, email = `${uuid}@acme.dev`) =>
        sealInvitation({ userId: uuid, email });

    const accept = (uuid: string, token = tokenFor(uuid)) =>
        useCase.execute({
            token,
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

    // GHSA-5rf5 #4: the user id is exposed elsewhere, so it must not be the
    // credential of the invitation.
    it('does not accept the invited user id instead of the invitation token', async () => {
        for (const body of [{ uuid: 'invited' }, { token: 'invited' }]) {
            await expect(
                useCase.execute({
                    ...body,
                    name: 'Someone',
                    password: 'Str0ngP@ssw0rd!',
                } as any),
            ).rejects.toBeInstanceOf(NotFoundException);
        }
        expect(usersService.update).not.toHaveBeenCalled();
    });

    it('does not accept an invitation sent to another email', async () => {
        await expect(
            accept('invited', tokenFor('invited', 'someone-else@acme.dev')),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(usersService.update).not.toHaveBeenCalled();
    });

    it('does not accept an expired invitation', async () => {
        const expired = sealInvitation(
            { userId: 'invited', email: 'invited@acme.dev' },
            Date.now() - INVITATION_TTL_MS - 1,
        );

        await expect(accept('invited', expired)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(usersService.update).not.toHaveBeenCalled();
    });

    it('completes an open invitation, guarding the update by status', async () => {
        await accept('invited');
        expect(usersService.update).toHaveBeenCalledWith(
            { uuid: 'invited', status: STATUS.PENDING },
            expect.objectContaining({ status: STATUS.ACTIVE }),
        );
        expect(createProfile.execute).toHaveBeenCalled();
    });

    it('answers "User could not be found" when the invitation is not open', async () => {
        await expect(accept('active')).rejects.toThrow(
            'User could not be found',
        );
    });

    it('rejects a request without a payload', async () => {
        await expect(useCase.execute(undefined as any)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(usersService.update).not.toHaveBeenCalled();
    });

    it('creates no profile when the guarded update matches no row', async () => {
        // Another request accepted the invitation between the check and the
        // update, so the PENDING filter no longer matches.
        usersService.update.mockResolvedValueOnce(undefined as any);

        await expect(accept('invited')).rejects.toThrow(
            'User could not be found',
        );
        expect(createProfile.execute).not.toHaveBeenCalled();
    });

    it('creates the profile with the submitted name and phone', async () => {
        await useCase.execute({
            token: tokenFor('invited'),
            name: 'Someone',
            phone: '+55 11 99999-0000',
            password: 'Str0ngP@ssw0rd!',
        } as any);

        expect(createProfile.execute).toHaveBeenCalledWith({
            user: { uuid: 'invited' },
            name: 'Someone',
            phone: '+55 11 99999-0000',
        });
    });

    it('reports the accepted invitation with the user and organization', async () => {
        usersService.update.mockResolvedValueOnce({
            uuid: 'invited',
            email: 'invited@acme.dev',
            organization: { uuid: 'org-1' },
        } as any);

        await accept('invited');

        expect(telemetry.userInvitationAccepted).toHaveBeenCalledWith({
            userId: 'invited',
            email: 'invited@acme.dev',
            name: 'Someone',
            organizationId: 'org-1',
        });
    });

    it('does not report an accepted invitation without an email', async () => {
        usersService.update.mockResolvedValueOnce({ uuid: 'invited' } as any);

        await accept('invited');

        expect(telemetry.userInvitationAccepted).not.toHaveBeenCalled();
    });
});
