import { NotFoundException } from '@nestjs/common';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';

import { AcceptUserInvitationUseCase } from './accept-user-invitation.use-case';
import { GetInvitationTokenUseCase } from './get-invitation-token.use-case';
import { InviteDataUserUseCase } from './invite-data.use-case';

/**
 * The whole invitation, through the real use cases over one in-memory store:
 * the owner copies the link, the invitee opens it and accepts it, and the
 * same link, or one with the bare user id, never works again.
 */
describe('invitation flow', () => {
    const cryptoKey = process.env.API_CRYPTO_KEY;
    beforeAll(() => {
        process.env.API_CRYPTO_KEY = 'ab'.repeat(32);
    });
    afterAll(() => {
        process.env.API_CRYPTO_KEY = cryptoKey;
    });

    const setup = () => {
        const users = [
            {
                uuid: 'invited',
                email: 'Invited@acme.dev',
                status: STATUS.PENDING,
                password: undefined as string | undefined,
                organization: { uuid: 'org-1', name: 'Acme' },
            },
        ];
        const profiles: Array<{ user: { uuid: string }; name: string }> = [];
        const matches = (u: (typeof users)[number], f: any) =>
            (f.uuid === undefined || u.uuid === f.uuid) &&
            (f.status === undefined || u.status === f.status) &&
            (f.organization?.uuid === undefined ||
                u.organization.uuid === f.organization.uuid);
        // As the real service: an entity with toObject().
        const entity = (u: (typeof users)[number] | undefined) =>
            u ? { ...u, toObject: () => ({ ...u }) } : null;
        const usersService = {
            findOne: jest.fn(async (f: any) =>
                entity(users.find((u) => matches(u, f))),
            ),
            update: jest.fn(async (f: any, data: any) => {
                const user = users.find((u) => matches(u, f));
                if (!user) return null;
                Object.assign(user, data);
                return entity(user);
            }),
        };
        const profileService = {
            findOne: jest.fn(
                async (f: any) =>
                    profiles.find((p) => p.user.uuid === f.user.uuid) ?? null,
            ),
        };
        const createProfileUseCase = {
            execute: jest.fn(async (p: any) => {
                profiles.push(p);
            }),
        };
        const cryptoService = {
            hashPassword: jest.fn(async (p: string) => `hashed:${p}`),
        };
        const telemetry = { userInvitationAccepted: jest.fn() };

        return {
            users,
            profiles,
            copyLink: new GetInvitationTokenUseCase(
                usersService as any,
                profileService as any,
            ),
            open: new InviteDataUserUseCase(
                usersService as any,
                profileService as any,
            ),
            accept: new AcceptUserInvitationUseCase(
                usersService as any,
                cryptoService as any,
                createProfileUseCase as any,
                telemetry as any,
                profileService as any,
            ),
        };
    };

    it('lets the invitee open and accept the link the owner copied, once', async () => {
        const { users, profiles, copyLink, open, accept } = setup();

        const { token } = await copyLink.execute('invited', 'org-1');
        expect(await open.execute(token)).toMatchObject({
            uuid: 'invited',
            email: 'Invited@acme.dev',
            organization: { name: 'Acme' },
        });

        await accept.execute({
            token,
            name: 'Invited Dev',
            password: 'Str0ng!pass',
        } as any);
        expect(users[0]).toMatchObject({
            status: STATUS.ACTIVE,
            password: 'hashed:Str0ng!pass',
        });
        expect(profiles).toEqual([
            expect.objectContaining({
                user: { uuid: 'invited' },
                name: 'Invited Dev',
            }),
        ]);

        // The same link is spent: it neither opens nor accepts again, and the
        // owner has no open invitation left to copy.
        expect(await open.execute(token)).toEqual({});
        await expect(
            accept.execute({ token, name: 'x', password: 'y' } as any),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            copyLink.execute('invited', 'org-1'),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never accepts a link with the bare user id, as links did before', async () => {
        const { users, open, accept } = setup();

        expect(await open.execute('invited')).toEqual({});
        await expect(
            accept.execute({
                token: 'invited',
                name: 'Attacker',
                password: 'pwned',
            } as any),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(users[0].status).toBe(STATUS.PENDING);
        expect(users[0].password).toBeUndefined();
    });

    it('gives an owner of another organization no link to copy', async () => {
        const { copyLink } = setup();

        await expect(
            copyLink.execute('invited', 'org-2'),
        ).rejects.toBeInstanceOf(NotFoundException);
    });
});
