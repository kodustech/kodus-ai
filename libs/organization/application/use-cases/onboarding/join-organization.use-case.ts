import { Inject, Injectable } from '@nestjs/common';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@libs/identity/domain/auth/contracts/auth.service.contracts';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    IProfileService,
    PROFILE_SERVICE_TOKEN,
} from '@libs/identity/domain/profile/contracts/profile.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@libs/organization/domain/teamMembers/contracts/teamMembers.service.contracts';
import { TeamMemberRole } from '@libs/organization/domain/teamMembers/enums/teamMemberRole.enum';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { createLogger } from '@kodus/flow';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { JoinOrganizationDto } from '@libs/identity/dtos/join-organization.dto';
import { environment } from '@libs/ee/configs/environment';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

@Injectable()
export class JoinOrganizationUseCase implements IUseCase {
    private readonly logger = createLogger(JoinOrganizationUseCase.name);

    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly userService: IUsersService,

        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: ITeamMemberService,

        @Inject(PROFILE_SERVICE_TOKEN)
        private readonly profileService: IProfileService,

        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly notificationService: NotificationService,
    ) {}

    public async execute(data: JoinOrganizationDto): Promise<IUser> {
        const { userId, organizationId } = data;

        try {
            const user = await this.userService.findOne({
                uuid: userId,
            });
            if (!user) {
                throw new Error('User not found');
            }

            const originalOrgId = user.organization.uuid;

            const profile = await this.profileService.findOne({
                user: { uuid: userId },
            });
            if (!profile) {
                throw new Error('Profile not found for the user');
            }

            const organization = await this.organizationService.findOne({
                uuid: organizationId,
            });
            if (!organization) {
                throw new Error('Organization not found');
            }

            if (originalOrgId === organizationId) {
                return user;
            }

            const team = await this.teamService.findOne({
                organization: { uuid: organizationId },
            });

            if (!team) {
                throw new Error('Team not found for the organization');
            }

            let teamMember = await this.teamMembersService.findOne({
                user: { uuid: user.uuid },
            });

            if (!teamMember) {
                teamMember = await this.teamMembersService.create({
                    team,
                    user,
                    organization,
                    name: profile.name,
                    teamRole: TeamMemberRole.MEMBER,
                    status: true,
                });
            } else {
                await this.teamMembersService.update(
                    {
                        uuid: teamMember.uuid,
                    },
                    {
                        team,
                        organization,
                        teamRole: TeamMemberRole.MEMBER,
                        status: true,
                    },
                );
            }

            const requiresEmailConfirmation = environment.API_CLOUD_MODE;
            const updatedUser = await this.userService.update(
                {
                    uuid: user.uuid,
                },
                {
                    role: Role.CONTRIBUTOR,
                    status: requiresEmailConfirmation
                        ? STATUS.PENDING_EMAIL
                        : STATUS.ACTIVE,
                    organization,
                },
            );

            if (!updatedUser) {
                throw new Error('Failed to update user with new organization');
            }

            if (requiresEmailConfirmation) {
                const token = await this.authService.createEmailToken(
                    user.uuid,
                    user.email,
                );

                await this.notificationService.emit({
                    event: NotificationEvent.AUTH_EMAIL_CONFIRMATION,
                    payload: {
                        token,
                        email: user.email,
                        organizationName: organization.name,
                        organizationAndTeamData: {
                            organizationId,
                            teamId: team.uuid,
                        },
                    },
                    organizationId,
                    recipients: { kind: 'user', userId: user.uuid },
                });
            }

            await this.cleanUp(originalOrgId);

            return updatedUser.toObject();
        } catch (error) {
            this.logger.error({
                message: `join_org step=error ${(error as Error)?.message}`,
                error,
                context: JoinOrganizationUseCase.name,
                serviceName: JoinOrganizationUseCase.name,
                metadata: {
                    step: 'error',
                    userId,
                    organizationId,
                    errorMessage: (error as Error)?.message,
                    errorName: (error as Error)?.name,
                },
            });

            throw error;
        }
    }

    async cleanUp(organizationId: string) {
        const usersInOrg = await this.userService.find({
            organization: { uuid: organizationId },
        });

        const teamsInOrg = await this.teamService.find({
            organization: { uuid: organizationId },
        });

        const originalTeamCount = teamsInOrg.length;
        while (teamsInOrg.length > 0) {
            const team = teamsInOrg.pop();
            if (!team) {
                break;
            }

            const teamMembers =
                await this.teamMembersService.findManyByRelations({
                    organizationId: organizationId,
                    teamId: team.uuid,
                });

            if (!teamMembers || teamMembers.length === 0) {
                await this.parametersService.deleteByTeamId(team.uuid);
                await this.teamService.deleteFisically(team.uuid);
            }
        }

        if (teamsInOrg.length > 0) {
            this.logger.warn({
                message: 'Not all teams were deleted during cleanup',
                context: JoinOrganizationUseCase.name,
                serviceName: JoinOrganizationUseCase.name,
                metadata: { organizationId, remainingTeams: teamsInOrg.length },
            });

            return;
        }

        if (!usersInOrg || usersInOrg.length === 0) {
            await this.organizationService.deleteOne({ uuid: organizationId });
        } else {
            this.logger.warn({
                message:
                    'Organization not deleted during cleanup, users still exist',
                context: JoinOrganizationUseCase.name,
                serviceName: JoinOrganizationUseCase.name,
                metadata: { organizationId, userCount: usersInOrg.length },
            });
        }

        this.logger.debug({
            message: 'Cleanup completed',
            context: JoinOrganizationUseCase.name,
            serviceName: JoinOrganizationUseCase.name,
            metadata: {
                organizationId,
                originalTeamCount,
                deletedTeams: originalTeamCount - teamsInOrg.length,
            },
        });
    }
}
