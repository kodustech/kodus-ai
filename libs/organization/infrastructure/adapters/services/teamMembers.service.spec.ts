import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { TeamMemberRole } from '@libs/organization/domain/teamMembers/enums/teamMemberRole.enum';

import { TeamMemberService } from './teamMembers.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('TeamMemberService — deterministic logic', () => {
    const makeService = (
        repo: any = {},
        usersService: any = {},
        notificationService: any = {},
    ): TeamMemberService =>
        new TeamMemberService(
            repo as any,
            usersService as any,
            notificationService as any,
        );

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('findTeamMembersFormated — member formatting/mapping', () => {
        const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };

        it('returns empty members when repository returns null', async () => {
            const repo = {
                findTeamMembersWithUser: jest.fn().mockResolvedValue(null),
            };
            const service = makeService(repo);

            const result = await service.findTeamMembersFormated(orgTeam);

            expect(result).toEqual({ members: [] });
        });

        it('returns empty members when repository returns an empty array', async () => {
            const repo = {
                findTeamMembersWithUser: jest.fn().mockResolvedValue([]),
            };
            const service = makeService(repo);

            const result = await service.findTeamMembersFormated(orgTeam);

            expect(result).toEqual({ members: [] });
        });

        it('maps every field exactly for a fully-populated active member', async () => {
            const member = {
                uuid: 'tm-1',
                status: true,
                communicationId: 'comm-1',
                avatar: 'avatar-url',
                name: 'Alice',
                communication: { name: 'Slack', id: 'slack-1' },
                codeManagement: { id: 'gh-1' },
                projectManagement: { id: 'jira-1' },
                teamRole: TeamMemberRole.TEAM_LEADER,
                user: {
                    email: 'alice@example.com',
                    uuid: 'user-1',
                    status: STATUS.ACTIVE,
                    role: Role.OWNER,
                },
            };
            const repo = {
                findTeamMembersWithUser: jest.fn().mockResolvedValue([member]),
            };
            const service = makeService(repo);

            const result = await service.findTeamMembersFormated(orgTeam);

            expect(result).toEqual({
                members: [
                    {
                        uuid: 'tm-1',
                        active: true,
                        communicationId: 'comm-1',
                        avatar: 'avatar-url',
                        name: 'Alice',
                        communication: { name: 'Slack', id: 'slack-1' },
                        codeManagement: { id: 'gh-1' },
                        projectManagement: { id: 'jira-1' },
                        email: 'alice@example.com',
                        userId: 'user-1',
                        teamRole: TeamMemberRole.TEAM_LEADER,
                        userStatus: STATUS.ACTIVE,
                        userExists: true,
                        role: Role.OWNER,
                    },
                ],
            });
        });

        it('defaults active to true when member.status is null/undefined (?? applies)', async () => {
            const repo = {
                findTeamMembersWithUser: jest
                    .fn()
                    .mockResolvedValue([
                        { uuid: 'tm-1', status: undefined, user: undefined },
                    ]),
            };
            const service = makeService(repo);

            const [mapped] = (await service.findTeamMembersFormated(orgTeam))
                .members;

            expect(mapped.active).toBe(true);
        });

        it('keeps active false when member.status is explicitly false (?? does not swallow false)', async () => {
            const repo = {
                findTeamMembersWithUser: jest
                    .fn()
                    .mockResolvedValue([
                        { uuid: 'tm-1', status: false, user: undefined },
                    ]),
            };
            const service = makeService(repo);

            const [mapped] = (await service.findTeamMembersFormated(orgTeam))
                .members;

            expect(mapped.active).toBe(false);
        });

        it('defaults role to CONTRIBUTOR when the user has no role (|| applies)', async () => {
            const repo = {
                findTeamMembersWithUser: jest.fn().mockResolvedValue([
                    {
                        uuid: 'tm-1',
                        status: true,
                        user: { uuid: 'u', status: STATUS.ACTIVE },
                    },
                ]),
            };
            const service = makeService(repo);

            const [mapped] = (await service.findTeamMembersFormated(orgTeam))
                .members;

            expect(mapped.role).toBe(Role.CONTRIBUTOR);
        });

        it('userExists is true only when user exists AND status === ACTIVE', async () => {
            const repo = {
                findTeamMembersWithUser: jest.fn().mockResolvedValue([
                    {
                        uuid: 'active',
                        status: true,
                        user: { uuid: 'u1', status: STATUS.ACTIVE },
                    },
                    {
                        uuid: 'pending',
                        status: true,
                        user: { uuid: 'u2', status: STATUS.PENDING },
                    },
                    { uuid: 'nouser', status: true, user: undefined },
                ]),
            };
            const service = makeService(repo);

            const { members } = await service.findTeamMembersFormated(orgTeam);

            expect(members.map((m: any) => m.userExists)).toEqual([
                true,
                false,
                undefined,
            ]);
        });

        it('resolves email/userId from the nested user and tolerates missing user (undefined, not throw)', async () => {
            const repo = {
                findTeamMembersWithUser: jest
                    .fn()
                    .mockResolvedValue([
                        { uuid: 'tm-1', status: true, user: undefined },
                    ]),
            };
            const service = makeService(repo);

            const [mapped] = (await service.findTeamMembersFormated(orgTeam))
                .members;

            expect(mapped.email).toBeUndefined();
            expect(mapped.userId).toBeUndefined();
            expect((mapped as any).userStatus).toBeUndefined();
        });

        it('falls back to empty members when the repository throws (catch path)', async () => {
            const repo = {
                findTeamMembersWithUser: jest
                    .fn()
                    .mockRejectedValue(new Error('db down')),
            };
            const service = makeService(repo);

            const result = await service.findTeamMembersFormated(orgTeam);

            expect(result).toEqual({ members: [] });
        });

        it('forwards the teamMembersStatus flag to the repository', async () => {
            const repo = {
                findTeamMembersWithUser: jest.fn().mockResolvedValue([]),
            };
            const service = makeService(repo);

            await service.findTeamMembersFormated(orgTeam, false);

            expect(repo.findTeamMembersWithUser).toHaveBeenCalledWith(
                orgTeam,
                false,
            );
        });
    });

    describe('getUserIdFromMembers — cross-org member matching/dedup', () => {
        const call = (
            service: TeamMemberService,
            members: any[],
            orgTeam: any,
        ) => (service as any).getUserIdFromMembers(members, orgTeam);

        it('returns the input untouched when the org has no members (null guard)', async () => {
            const repo = {
                findManyByOrganizationId: jest.fn().mockResolvedValue(null),
            };
            const service = makeService(repo);
            const members = [{ email: 'a@x.com' }];

            const result = await call(service, members, {
                organizationId: 'org-1',
                teamId: 'team-1',
            });

            expect(result).toBe(members);
            expect(repo.findManyByOrganizationId).toHaveBeenCalledWith(
                'org-1',
                [STATUS.ACTIVE, STATUS.PENDING],
            );
        });

        it('assigns userId from the first matching org member (first-wins)', async () => {
            const repo = {
                findManyByOrganizationId: jest.fn().mockResolvedValue([
                    {
                        uuid: 'tm-a',
                        user: { email: 'a@x.com', uuid: 'user-first' },
                        team: { uuid: 'other-team' },
                    },
                    {
                        uuid: 'tm-b',
                        user: { email: 'a@x.com', uuid: 'user-second' },
                        team: { uuid: 'other-team' },
                    },
                ]),
            };
            const service = makeService(repo);
            const members = [{ email: 'a@x.com' }];

            const [result] = await call(service, members, {
                organizationId: 'org-1',
                teamId: 'team-1',
            });

            expect(result.userId).toBe('user-first');
            // No membership on the target team → uuid stays unset
            expect(result.uuid).toBeUndefined();
        });

        it('sets uuid to the membership that belongs to the target team (dedup within same team)', async () => {
            const repo = {
                findManyByOrganizationId: jest.fn().mockResolvedValue([
                    {
                        uuid: 'tm-other',
                        user: { email: 'a@x.com', uuid: 'user-1' },
                        team: { uuid: 'other-team' },
                    },
                    {
                        uuid: 'tm-target',
                        user: { email: 'a@x.com', uuid: 'user-1' },
                        team: { uuid: 'team-1' },
                    },
                ]),
            };
            const service = makeService(repo);
            const members = [{ email: 'a@x.com' }];

            const [result] = await call(service, members, {
                organizationId: 'org-1',
                teamId: 'team-1',
            });

            expect(result.userId).toBe('user-1');
            expect(result.uuid).toBe('tm-target');
        });

        it('leaves userId undefined when no org member email matches', async () => {
            const repo = {
                findManyByOrganizationId: jest.fn().mockResolvedValue([
                    {
                        uuid: 'tm-x',
                        user: { email: 'someone@x.com', uuid: 'user-x' },
                        team: { uuid: 'team-1' },
                    },
                ]),
            };
            const service = makeService(repo);
            const members = [{ email: 'nomatch@x.com' }];

            const [result] = await call(service, members, {
                organizationId: 'org-1',
                teamId: 'team-1',
            });

            expect(result.userId).toBeUndefined();
            expect(result.uuid).toBeUndefined();
        });

        it('preserves order and processes every member', async () => {
            const repo = {
                findManyByOrganizationId: jest.fn().mockResolvedValue([
                    {
                        uuid: 'tm-b',
                        user: { email: 'b@x.com', uuid: 'user-b' },
                        team: { uuid: 'team-1' },
                    },
                ]),
            };
            const service = makeService(repo);
            const members = [{ email: 'a@x.com' }, { email: 'b@x.com' }];

            const result = await call(service, members, {
                organizationId: 'org-1',
                teamId: 'team-1',
            });

            expect(result.map((m: any) => m.email)).toEqual([
                'a@x.com',
                'b@x.com',
            ]);
            expect(result[0].userId).toBeUndefined();
            expect(result[1].userId).toBe('user-b');
            expect(result[1].uuid).toBe('tm-b');
        });
    });

    describe('checkExistingUsersInOtherOrganizations — valid/problematic partition', () => {
        const call = (
            service: TeamMemberService,
            emails: string[],
            orgId: string,
        ) =>
            (service as any).checkExistingUsersInOtherOrganizations(
                emails,
                orgId,
            );

        it('returns success with no problematic users when none are found in other orgs', async () => {
            const usersService = {
                findUsersWithEmailsInDifferentOrganizations: jest
                    .fn()
                    .mockResolvedValue([]),
            };
            const service = makeService({}, usersService);

            const result = await call(service, ['a@x.com'], 'org-1');

            expect(result).toEqual({ success: true, problematicUserIds: [] });
        });

        it('flags problematic users, mapping only email+uuid, and returns success=false', async () => {
            const usersService = {
                findUsersWithEmailsInDifferentOrganizations: jest
                    .fn()
                    .mockResolvedValue([
                        {
                            email: 'a@x.com',
                            uuid: 'user-a',
                            extra: 'ignored',
                        },
                    ]),
            };
            const service = makeService({}, usersService);

            const result = await call(service, ['a@x.com'], 'org-1');

            expect(result).toEqual({
                success: false,
                problematicUserIds: [{ email: 'a@x.com', uuid: 'user-a' }],
            });
            expect(
                usersService.findUsersWithEmailsInDifferentOrganizations,
            ).toHaveBeenCalledWith(['a@x.com'], 'org-1');
        });
    });

    describe('createTeamMember — email-to-name derivation and defaults', () => {
        const orgTeam = { organizationId: 'org-9', teamId: 'team-9' };
        const call = (service: TeamMemberService, member: any, user: any) =>
            (service as any).createTeamMember(orgTeam, member, user);

        it('derives the name from the local part before @ when no name is given', async () => {
            const create = jest.fn().mockResolvedValue(undefined);
            const service = makeService({ create });

            await call(
                service,
                { email: 'john.doe@example.com' },
                { uuid: 'u' },
            );

            expect(create).toHaveBeenCalledTimes(1);
            expect(create.mock.calls[0][0].name).toBe('john.doe');
        });

        it('prefers the explicit member name over the derived one (?? does not override a provided name)', async () => {
            const create = jest.fn().mockResolvedValue(undefined);
            const service = makeService({ create });

            await call(
                service,
                { email: 'john.doe@example.com', name: 'Johnny' },
                { uuid: 'u' },
            );

            expect(create.mock.calls[0][0].name).toBe('Johnny');
        });

        it('defaults teamRole to MEMBER and user uuid falls back to the created user', async () => {
            const create = jest.fn().mockResolvedValue(undefined);
            const service = makeService({ create });

            await call(
                service,
                { email: 'a@b.com', active: true },
                { uuid: 'created-user' },
            );

            const arg = create.mock.calls[0][0];
            expect(arg.teamRole).toBe(TeamMemberRole.MEMBER);
            expect(arg.user).toEqual({ uuid: 'created-user' });
            expect(arg.organization).toEqual({ uuid: 'org-9' });
            expect(arg.team).toEqual({ uuid: 'team-9' });
            expect(arg.status).toBe(true);
        });

        it('prefers member.userId over the created user uuid (|| picks the truthy left)', async () => {
            const create = jest.fn().mockResolvedValue(undefined);
            const service = makeService({ create });

            await call(
                service,
                { email: 'a@b.com', userId: 'existing-user' },
                { uuid: 'created-user' },
            );

            expect(create.mock.calls[0][0].user).toEqual({
                uuid: 'existing-user',
            });
        });
    });

    describe('generateTemporaryPassword — deterministic shape', () => {
        it('produces a 16-char password from the alphanumeric charset only', () => {
            const service = makeService();

            const password = (service as any).generateTemporaryPassword();

            expect(typeof password).toBe('string');
            expect(password).toHaveLength(16);
            expect(password).toMatch(/^[A-Za-z0-9]{16}$/);
        });

        it('does not repeat the same password across calls (uses randomness)', () => {
            const service = makeService();

            const a = (service as any).generateTemporaryPassword();
            const b = (service as any).generateTemporaryPassword();

            expect(a).not.toBe(b);
        });
    });
});
