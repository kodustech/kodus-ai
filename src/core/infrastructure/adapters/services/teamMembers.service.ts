import {
    ITeamMemberRepository,
    TEAM_MEMBERS_REPOSITORY_TOKEN,
} from '@/core/domain/teamMembers/contracts/teamMembers.repository.contracts';
import {
    IMembers,
    ITeamMember,
} from '@/core/domain/teamMembers/interfaces/team-members.interface';
import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { CommunicationService } from './platformIntegration/communication.service';
import {
    IMSTeamsService,
    MSTEAMS_SERVICE_TOKEN,
} from '@/core/domain/msTeams/msTeams.service.contract';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { TeamMemberEntity } from '@/core/domain/teamMembers/entities/teamMember.entity';
import { ITeamMemberService } from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@/core/domain/user/contracts/user.service.contract';
import { STATUS } from '@/config/types/database/status.type';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { UserRole } from '@/core/domain/user/enums/userRole.enum';
import { sendInvite } from '@/shared/utils/email/sendMail';
import { TeamMemberRole } from '@/core/domain/teamMembers/enums/teamMemberRole.enum';

@Injectable()
export class TeamMemberService implements ITeamMemberService {
    constructor(
        @Inject(TEAM_MEMBERS_REPOSITORY_TOKEN)
        private readonly teamMembersRepository: ITeamMemberRepository,

        @Inject(forwardRef(() => MSTEAMS_SERVICE_TOKEN))
        private readonly msTeamsService: IMSTeamsService,

        private readonly communication: CommunicationService,

        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
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
                }),
            );

            return { members: communicationUsersFormatted };
        } catch (error) {
            console.log(error);
            return { members: [] };
        }
    }

    //#region updateOrCreateMembers
    async updateOrCreateMembers(
        members: IMembers[],
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any> {
        try {
            const emails = members.map((member) => member.email);
            const usersToSendInvite = [];

            const { success, problematicUserIds } =
                await this.checkExistingUsersInOtherOrganizations(
                    emails,
                    organizationAndTeamData.organizationId,
                );

            if (!success) {
                return { success: false, problematicUserIds };
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
            }

            if (usersToSendInvite?.length > 0) {
                this.sendInvitations(
                    usersToSendInvite,
                    organizationAndTeamData,
                );
            }

            return { success: true };
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
                role: [UserRole.USER],
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
    ) {
        const admin = await this.usersService.findOne({
            organization: { uuid: organizationAndTeamData.organizationId },
            role: [UserRole.OWNER],
        });

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

            await sendInvite(user, admin?.email, inviteLink);
        }
    }

    private generateTemporaryPassword(): string {
        return (
            Math.random().toString(36).slice(-8) +
            Math.random().toString(36).slice(-8)
        );
    }

    async findMembersByCommunicationId(communicationId: string) {
        return await this.teamMembersRepository.findMembersByCommunicationId(
            communicationId,
        );
    }
}
