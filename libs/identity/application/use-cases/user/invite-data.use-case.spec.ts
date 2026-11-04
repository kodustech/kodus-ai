import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';

import { sealInvitation } from '@libs/identity/domain/user/invitation-token';

import { InviteDataUserUseCase } from './invite-data.use-case';

describe('InviteDataUserUseCase', () => {
    const cryptoKey = process.env.API_CRYPTO_KEY;
    beforeAll(() => {
        process.env.API_CRYPTO_KEY = 'cd'.repeat(32);
    });
    afterAll(() => {
        process.env.API_CRYPTO_KEY = cryptoKey;
    });
    const tokenFor = (uuid: string, email = `${uuid}@acme.dev`) =>
        sealInvitation({ userId: uuid, email });

    const pending = {
        invited: { uuid: 'invited', email: 'invited@acme.dev' },
        signup: { uuid: 'signup', email: 'signup@acme.dev' },
    };
    const usersService = {
        findOne: jest.fn(async (filter: { uuid: string; status: STATUS }) => {
            const user = pending[filter.uuid];
            return user && filter.status === STATUS.PENDING
                ? {
                      email: user.email,
                      toObject: () => ({
                          ...user,
                          organization: { name: 'Acme' },
                      }),
                  }
                : null;
        }),
    };
    // Self sign-ups get a profile at sign-up; invites only when accepted.
    const profileService = {
        findOne: jest.fn(async (filter: { user: { uuid: string } }) =>
            filter.user.uuid === 'signup' ? { uuid: 'p' } : null,
        ),
    };
    const useCase = new InviteDataUserUseCase(
        usersService as any,
        profileService as any,
    );

    it('shows an open invitation', async () => {
        await expect(useCase.execute(tokenFor('invited'))).resolves.toEqual({
            uuid: 'invited',
            email: 'invited@acme.dev',
            organization: { name: 'Acme' },
        });
    });

    it('does not reveal a self sign-up that is still pending', async () => {
        await expect(useCase.execute(tokenFor('signup'))).resolves.toEqual({});
    });

    it('returns nothing for an unknown id', async () => {
        await expect(useCase.execute(tokenFor('missing'))).resolves.toEqual({});
    });

    it('does not show an invitation for the bare user id', async () => {
        usersService.findOne.mockClear();

        await expect(useCase.execute('invited')).resolves.toEqual({});
        expect(usersService.findOne).not.toHaveBeenCalled();
    });

    it('does not show an invitation sent to another email', async () => {
        await expect(
            useCase.execute(tokenFor('invited', 'someone-else@acme.dev')),
        ).resolves.toEqual({});
    });

    it('returns nothing without a token, without querying', async () => {
        usersService.findOne.mockClear();

        await expect(useCase.execute('')).resolves.toEqual({});
        expect(usersService.findOne).not.toHaveBeenCalled();
    });

    it('shows an invitation whose user has no organization loaded', async () => {
        usersService.findOne.mockResolvedValueOnce({
            email: 'invited@acme.dev',
            toObject: () => ({ uuid: 'invited', email: 'invited@acme.dev' }),
        } as any);

        await expect(useCase.execute(tokenFor('invited'))).resolves.toEqual({
            uuid: 'invited',
            email: 'invited@acme.dev',
            organization: { name: undefined },
        });
    });
});
