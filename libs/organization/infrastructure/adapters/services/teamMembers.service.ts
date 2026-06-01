import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    ITeamMemberRepository,
    TEAM_MEMBERS_REPOSITORY_TOKEN,
} from '@libs/organization/domain/teamMembers/contracts/teamMembers.repository.contracts';
import { ITeamMemberService } from '@libs/organization/domain/teamMembers/contracts/teamMembers.service.contracts';
import { TeamMemberEntity } from '@libs/organization/domain/teamMembers/entities/teamMember.entity';
import { TeamMemberRole } from '@libs/organization/domain/teamMembers/enums/teamMemberRole.enum';
import {
    IMembers,
    ITeamMember,
    IInviteResult,
    IUpdateOrCreateMembersResponse,
} from '@libs/organization/domain/teamMembers/interfaces/teamMembers.interface';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { createLogger } from '@kodus/flow';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

@Injectable()
export class TeamMemberService implements ITeamMemberService {
    private readonly logger = createLogger(TeamMemberService.name);

    constructor(
        @Inject(TEAM_MEMBERS_REPOSITORY_TOKEN)
        private readonly teamMembersRepository: ITeamMemberRepository,

        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,

        private readonly notificationService: NotificationService,
    ) {}

    findManyById(ids: string[]): Promise<TeamMemberEntity[]> {
        throw new Error('Method not implemented.');
    }

    findManyByOrganizationId(
        organizationId: string,
        teamStatus: STATUS[],
    ): Promise<TeamMemberEntity[]> {
        return this.teamMembersRepository.findManyByOrganizationId(
            organizationId,
            teamStatus,
        );
    }

    findManyByUser(
        userId: string,
        teamMemberStatus: boolean = true,
    ): Promise<TeamMemberEntity[]> {
        return this.teamMembersRepository.findManyByUser(
            userId,
            teamMemberStatus,
        );
    }

    findManyByRelations(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<TeamMemberEntity[]> {
        return this.teamMembersRepository.findManyByRelations(
            organizationAndTeamData,
        );
    }

    public findOne(filter: Partial<ITeamMember>): Promise<TeamMemberEntity> {
        return this.teamMembersRepository.findOne(filter);
    }

    async create(teamMember: ITeamMember): Promise<any> {
        return this.teamMembersRepository.create(teamMember);
    }

    async update(
        filter: Partial<ITeamMember>,
        teamMember: Partial<ITeamMember>,
    ): Promise<any> {
        return this.teamMembersRepository.update(filter, teamMember);
    }

    updateMembers(
        members: IMembers[],
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        return this.teamMembersRepository.updateMembers(
            members,
            organizationAndTeamData,
        );
    }

    deleteMembers(members: TeamMemberEntity[]): Promise<void> {
        return this.teamMembersRepository.deleteMembers(members);
    }

    countTeamMembers(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<number> {
        return this.teamMembersRepository.countTeamMembers(
            organizationAndTeamData,
        );
    }

    async countByUser(
        userId: string,
        teamMemberStatus?: boolean,
    ): Promise<number> {
        return await this.teamMembersRepository.countByUser(
            userId,
            teamMemberStatus,
        );
    }

    getLeaderMembers(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<TeamMemberEntity[]> {
        return this.teamMembersRepository.getLeaderMembers(
            organizationAndTeamData,
        );
    }

    findTeamMembersWithUser(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<TeamMemberEntity[]> {
        return this.teamMembersRepository.findTeamMembersWithUser(
            organizationAndTeamData,
        );
    }

    async findTeamMembersFormated(
        organizationAndTeamData: OrganizationAndTeamData,
        teamMembersStatus?: boolean,
    ): Promise<{ members: IMembers[] }> {
        try {
            const teamMembers =
                await this.teamMembersRepository.findTeamMembersWithUser(
                    organizationAndTeamData,
                    teamMembersStatus,
                );

            if (!teamMembers || teamMembers.length === 0) {
                return { members: [] };
            }

            const communicationUsersFormatted: IMembers[] = teamMembers.map(
                (member) => ({
                    uuid: member.uuid,
                    active: member.status ?? true,
                    communicationId: member?.communicationId,
                    avatar: member?.avatar,
                    name: member?.name,
                    communication: {
                        name: member?.communication?.name,
                        id: member?.communication?.id,
                    },
                    codeManagement: member?.codeManagement,
                    projectManagement: member?.projectManagement,
                    email: member.user?.email,
                    userId: member.user?.uuid,
                    teamRole: member?.teamRole,
                    userStatus: member?.user?.status,
                    userExists:
                        member.user && member.user.status === STATUS.ACTIVE,
                    role: member?.user?.role || Role.CONTRIBUTOR,
                }),
            );

            return { members: communicationUsersFormatted };
        } catch (error) {
            this.logger.error({
                message: 'Error in findTeamMembersFormated',
                error:
                    error instanceof Error ? error : new Error(String(error)),
                context: 'TeamMemberService.findTeamMembersFormated',
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
            });
            return { members: [] };
        }
    }

    //#region updateOrCreateMembers
    async updateOrCreateMembers(
        members: IMembers[],
        organizationAndTeamData: OrganizationAndTeamData,
        inviterEmail?: string,
    ): Promise<IUpdateOrCreateMembersResponse> {
        try {
            const emails = members.map((member) => member.email);
            const usersToSendInvite = [];
            const results: IInviteResult[] = [];

            const { success, problematicUserIds } =
                await this.checkExistingUsersInOtherOrganizations(
                    emails,
                    organizationAndTeamData.organizationId,
                );

            // Process problematic users (users already in other organizations)
            if (problematicUserIds.length > 0) {
                for (const problematicUser of problematicUserIds) {
                    results.push({
                        email: problematicUser.email,
                        status: 'user_already_registered_in_other_organization',
                        uuid: problematicUser.uuid,
                        message:
                            'User already registered in another organization',
                    });
                }
            }

            // If there are problematic users, we still process the valid ones
            if (!success) {
                // Continue processing valid users but return partial success
                const validEmails = emails.filter(
                    (email) =>
                        !problematicUserIds.some((pu) => pu.email === email),
                );

                if (validEmails.length === 0) {
                    return {
                        success: false,
                        results,
                    };
                }

                // Filter members to only include valid ones
                members = members.filter((member) =>
                    validEmails.includes(member.email),
                );
            }

            members = await this.getUserIdFromMembers(
                members,
                organizationAndTeamData,
            );

            for (const member of members) {
                let user: IUser;

                if (member.userId) {
                    user = await this.usersService.findOne({
                        uuid: member.userId,
                    });

                    if (user && user.status !== STATUS.ACTIVE) {
                        usersToSendInvite.push(user);
                    }
                } else {
                    user = await this.createNewUser(
                        organizationAndTeamData,
                        member,
                    );

                    usersToSendInvite.push(user);
                }

                if (!member.uuid) {
                    await this.createTeamMember(
                        organizationAndTeamData,
                        member,
                        user,
                    );
                } else {
                    await this.updateTeamMember(
                        organizationAndTeamData,
                        member,
                    );
                }

                // Add successful result
                results.push({
                    email: member.email,
                    status: 'invite_sent',
                    message: 'Invite sent successfully',
                });
            }

            if (usersToSendInvite?.length > 0) {
                this.sendInvitations(
                    usersToSendInvite,
                    organizationAndTeamData,
                    inviterEmail,
                ).catch((error) => {
                    this.logger.error({
                        message: 'Error sending invitations',
                        error,
                        context: TeamMemberService.name,
                    });
                });
            }

            return {
                success: true,
                results,
            };
        } catch (error) {
            throw new Error(error);
        }
    }

    private async checkExistingUsersInOtherOrganizations(
        emails: string[],
        organizationId: string,
    ): Promise<{
        success: boolean;
        problematicUserIds: { email: string; uuid: string }[];
    }> {
        const usersInOtherOrgs =
            await this.usersService.findUsersWithEmailsInDifferentOrganizations(
                emails,
                organizationId,
            );

        const problematicUsers = usersInOtherOrgs.map((user) => ({
            email: user.email,
            uuid: user.uuid,
        }));

        if (problematicUsers.length > 0) {
            return {
                success: false,
                problematicUserIds: problematicUsers,
            };
        }

        return { success: true, problematicUserIds: [] };
    }

    private async getUserIdFromMembers(
        members: IMembers[],
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IMembers[]> {
        const membersWithUserId: IMembers[] = [];

        const membersOfOrganization = await this.findManyByOrganizationId(
            organizationAndTeamData.organizationId,
            [STATUS.ACTIVE, STATUS.PENDING],
        );

        if (!membersOfOrganization) {
            return members;
        }

        for (const member of members) {
            const foundMembers = membersOfOrganization?.filter(
                (orgMember) => orgMember?.user?.email === member?.email,
            );

            if (foundMembers?.length > 0) {
                member.userId = foundMembers[0]?.user?.uuid;
                foundMembers.forEach((foundMember) => {
                    // If the member is in the same team, we update the uuid.
                    // This is done to prevent the same user from being added more than once to the same team
                    if (
                        foundMember?.team?.uuid ===
                        organizationAndTeamData.teamId
                    ) {
                        member.uuid = foundMember?.uuid;
                        return;
                    }
                });
            }

            membersWithUserId.push(member);
        }

        return membersWithUserId;
    }

    private async createNewUser(
        organizationAndTeamData: OrganizationAndTeamData,
        member: IMembers,
    ): Promise<IUser> {
        let user: IUser;

        user = await this.usersService.find(
            {
                email: member.email,
                organization: {
                    uuid: organizationAndTeamData.organizationId,
                },
            },
            [STATUS.ACTIVE, STATUS.PENDING],
        )[0];

        if (!user) {
            user = await this.usersService.register({
                email: member.email,
                password: this.generateTemporaryPassword(),
                role: Role.CONTRIBUTOR,
                status: STATUS.PENDING,
                organization: {
                    uuid: organizationAndTeamData.organizationId,
                },
            });
        }

        return user;
    }

    private async createTeamMember(
        organizationAndTeamData: OrganizationAndTeamData,
        member: IMembers,
        user: IUser,
    ) {
        const name = member.email.split('@')[0];

        await this.create({
            uuid: member?.uuid,
            name: member?.name ?? name,
            status: member?.active,
            avatar: member?.avatar,
            communicationId: member?.communicationId,
            communication: member?.communication,
            teamRole: member?.teamRole ?? TeamMemberRole.MEMBER,
            user: { uuid: member?.userId || user?.uuid },
            organization: {
                uuid: organizationAndTeamData?.organizationId,
            },
            team: { uuid: organizationAndTeamData?.teamId },
        });
    }

    private async updateTeamMember(
        organizationAndTeamData: OrganizationAndTeamData,
        member: IMembers,
    ) {
        await this.update(
            { uuid: member.uuid },
            {
                uuid: member.uuid,
                name: member.name,
                status: member.active,
                teamRole: member.teamRole ?? TeamMemberRole.MEMBER,
                avatar: member?.avatar,
                communicationId: member?.communicationId,
                communication: member?.communication,
                codeManagement: member?.codeManagement,
                projectManagement: member?.projectManagement,
                organization: {
                    uuid: organizationAndTeamData.organizationId,
                },
                team: { uuid: organizationAndTeamData.teamId },
            },
        );
    }
    //#endregion

    public async sendInvitations(
        usersToSendInvitation: Partial<IUser[]>,
        organizationAndTeamData: OrganizationAndTeamData,
        inviterEmail?: string,
    ) {
        // Use the actual inviter's email if provided, otherwise fall back to the org owner
        let senderEmail = inviterEmail;
        if (!senderEmail) {
            const admin = await this.usersService.findOne({
                organization: {
                    uuid: organizationAndTeamData.organizationId,
                },
                role: Role.OWNER,
            });
            senderEmail = admin?.email;
        }

        for (const userToSendInvitation of usersToSendInvitation) {
            const user = await this.usersService.findOne({
                uuid: userToSendInvitation.uuid,
            });

            const inviteLink = `${process.env.API_USER_INVITE_BASE_URL}/invite/${user.uuid}`;

            const filteredMembers = user?.teamMember?.filter(
                (member) =>
                    member.organization.uuid ===
                    organizationAndTeamData.organizationId,
            );

            if (!filteredMembers && filteredMembers.length <= 0) {
                return;
            }

            await this.notificationService.emit({
                event: NotificationEvent.TEAM_MEMBER_INVITED,
                payload: {
                    user,
                    inviterEmail: senderEmail,
                    inviteLink,
                },
                organizationId: organizationAndTeamData.organizationId,
                recipients: { kind: 'user', userId: user.uuid },
            });
        }
    }

    private generateTemporaryPassword(): string {
        // Use cryptographically secure random bytes with rejection sampling
        // to avoid modulo bias when mapping bytes to characters
        const chars =
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const length = 16;
        // Largest multiple of chars.length that fits in a byte (256)
        // 256 - (256 % 62) = 256 - 8 = 248
        const maxByte = 256 - (256 % chars.length);
        let password = '';

        while (password.length < length) {
            const bytes = randomBytes(length - password.length);
            for (const byte of bytes) {
                if (byte < maxByte) {
                    password += chars[byte % chars.length];
                    if (password.length >= length) break;
                }
            }
        }

        return password;
    }

    async findMembersByCommunicationId(communicationId: string) {
        return await this.teamMembersRepository.findMembersByCommunicationId(
            communicationId,
        );
    }
}
