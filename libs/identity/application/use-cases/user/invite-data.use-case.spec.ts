import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';

import { InviteDataUserUseCase } from './invite-data.use-case';

describe('InviteDataUserUseCase', () => {
    const pending = {
        invited: { uuid: 'invited', email: 'invited@acme.dev' },
        signup: { uuid: 'signup', email: 'signup@acme.dev' },
    };
    const usersService = {
        findOne: jest.fn(async (filter: { uuid: string; status: STATUS }) => {
            const user = pending[filter.uuid];
            return user && filter.status === STATUS.PENDING
                ? {
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
        await expect(useCase.execute('invited')).resolves.toEqual({
            uuid: 'invited',
            email: 'invited@acme.dev',
            organization: { name: 'Acme' },
        });
    });

    it('does not reveal a self sign-up that is still pending', async () => {
        await expect(useCase.execute('signup')).resolves.toEqual({});
    });

    it('returns nothing for an unknown id', async () => {
        await expect(useCase.execute('missing')).resolves.toEqual({});
    });
});
