import { environment } from '@libs/ee/configs/environment';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import { SignUpUseCase } from './signup.use-case';

describe('SignUpUseCase — user status when joining an existing org', () => {
    // Matrix: (CLOUD vs SELF-HOSTED) × (self-claim vs IdP-verified).
    // The owner-create branch (no organizationId) is unconditionally ACTIVE and
    // exercised separately below to lock that contract in.

    let originalCloudMode: boolean;

    const buildDeps = () => {
        const org = { uuid: 'org-1', name: 'Acme' };
        return {
            organizationService: {
                findOne: jest.fn().mockResolvedValue(org),
                createOrganizationWithTenant: jest.fn().mockResolvedValue(org),
            },
            usersService: {
                count: jest.fn().mockResolvedValue(0),
                register: jest
                    .fn()
                    .mockImplementation(async (u) => ({
                        ...u,
                        uuid: 'user-1',
                        organization: org,
                        toObject: () => ({
                            ...u,
                            uuid: 'user-1',
                            organization: org,
                        }),
                    })),
            },
            teamMembersService: {
                create: jest.fn().mockResolvedValue({ uuid: 'tm-1' }),
            },
            teamService: {
                findOne: jest.fn().mockResolvedValue({ uuid: 'team-1' }),
            },
            createProfileUseCase: { execute: jest.fn() },
            createTeamUseCase: {
                execute: jest.fn().mockResolvedValue({ uuid: 'team-1' }),
            },
            emailService: { createContact: jest.fn() },
            telemetry: { userSignedUp: jest.fn() },
        };
    };

    const buildUseCase = (deps: ReturnType<typeof buildDeps>) =>
        new SignUpUseCase(
            deps.organizationService as any,
            deps.usersService as any,
            deps.teamMembersService as any,
            deps.teamService as any,
            deps.createProfileUseCase as any,
            deps.createTeamUseCase as any,
            deps.emailService as any,
            deps.telemetry as any,
        );

    const runWith = async (
        cloudMode: boolean,
        options?: Parameters<SignUpUseCase['execute']>[1],
    ) => {
        environment.API_CLOUD_MODE = cloudMode;
        const deps = buildDeps();
        await buildUseCase(deps).execute(
            {
                email: 'sso-user@scorpion.co',
                name: 'SSO User',
                password: 'random-bytes',
                organizationId: 'org-1',
            } as any,
            options,
        );
        return deps.usersService.register.mock.calls[0][0];
    };

    beforeEach(() => {
        jest.clearAllMocks();
        originalCloudMode = environment.API_CLOUD_MODE;
    });

    afterEach(() => {
        environment.API_CLOUD_MODE = originalCloudMode;
    });

    describe('with organizationId (auto-join / SSO path)', () => {
        it('cloud + self-claim → PENDING (must confirm email)', async () => {
            const registered = await runWith(true);
            expect(registered.status).toBe(STATUS.PENDING);
            expect(registered.role).toBe(Role.CONTRIBUTOR);
        });

        it('self-hosted + self-claim → ACTIVE (no email infra)', async () => {
            const registered = await runWith(false);
            expect(registered.status).toBe(STATUS.ACTIVE);
        });

        it('cloud + preVerified (SSO) → ACTIVE (IdP attested)', async () => {
            const registered = await runWith(true, { preVerified: true });
            expect(registered.status).toBe(STATUS.ACTIVE);
        });

        it('self-hosted + preVerified (SSO) → ACTIVE', async () => {
            const registered = await runWith(false, { preVerified: true });
            expect(registered.status).toBe(STATUS.ACTIVE);
        });
    });

    describe('without organizationId (owner self-signup)', () => {
        // This branch is the path 1 case — user creates their own org and is
        // always ACTIVE owner. preVerified / cloud mode shouldn't matter here.
        it('always ACTIVE owner regardless of cloud mode', async () => {
            environment.API_CLOUD_MODE = true;
            const deps = buildDeps();
            deps.organizationService.findOne.mockResolvedValue(null);

            await buildUseCase(deps).execute({
                email: 'owner@scorpion.co',
                name: 'Owner',
                password: 'random-bytes',
            } as any);

            const registered = deps.usersService.register.mock.calls[0][0];
            expect(registered.status).toBe(STATUS.ACTIVE);
            expect(registered.role).toBe(Role.OWNER);
        });
    });

    describe('team_member membership status (P3 regression)', () => {
        // The `team_member.status` flag controls whether the member shows up
        // in the Workspace members list. It must be active for owners and for
        // trusted provisioning (SSO/preVerified), and must stay inactive for a
        // plain non-owner join — regardless of cloud mode. Guards the
        // `status: isOwner || !!options?.preVerified` rule against regression.
        const membershipStatusFromCreate = (
            deps: ReturnType<typeof buildDeps>,
        ) => deps.teamMembersService.create.mock.calls[0][0].status;

        it('SSO provisioning (preVerified, non-owner) → membership ACTIVE — even in cloud', async () => {
            environment.API_CLOUD_MODE = true;
            const deps = buildDeps();
            await buildUseCase(deps).execute(
                {
                    email: 'sso@acme.com',
                    name: 'SSO User',
                    password: 'x',
                    organizationId: 'org-1',
                } as any,
                { preVerified: true },
            );
            expect(membershipStatusFromCreate(deps)).toBe(true);
        });

        it('plain non-owner join (no preVerified) → membership INACTIVE — unchanged', async () => {
            environment.API_CLOUD_MODE = true;
            const deps = buildDeps();
            await buildUseCase(deps).execute({
                email: 'invitee@acme.com',
                name: 'Invitee',
                password: 'x',
                organizationId: 'org-1',
            } as any);
            expect(membershipStatusFromCreate(deps)).toBe(false);
        });

        it('owner self-signup → membership ACTIVE', async () => {
            const deps = buildDeps();
            deps.organizationService.findOne.mockResolvedValue(null);
            await buildUseCase(deps).execute({
                email: 'owner@acme.com',
                name: 'Owner',
                password: 'x',
            } as any);
            expect(membershipStatusFromCreate(deps)).toBe(true);
        });
    });
});
