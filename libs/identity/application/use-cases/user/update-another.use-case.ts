import { Inject, Injectable } from '@nestjs/common';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { createLogger } from '@libs/core/log/logger';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@libs/organization/domain/teamMembers/contracts/teamMembers.service.contracts';
import { UpdateAnotherUserDto } from '@libs/identity/dtos/update-another-user.dto';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { UserRoleChangeLogParams } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/userManagementLog.handler';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

@Injectable()
export class UpdateAnotherUserUseCase implements IUseCase {
    private readonly logger = createLogger(UpdateAnotherUserUseCase.name);

    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,

        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: ITeamMemberService,

        private readonly eventEmitter: EventEmitter2,

        private readonly notificationService: NotificationService,
    ) {}

    async execute(
        userId: string,
        targetUserId: string,
        data: UpdateAnotherUserDto,
        organizationId: string,
    ): Promise<IUser> {
        const { role, status } = data;

        try {
            const targetUser = await this.usersService.findOne({
                uuid: targetUserId,
            });
            if (!targetUser) {
                throw new Error('Target user not found');
            }

            const organization = await this.organizationService.findOne({
                uuid: organizationId,
            });
            if (!organization) {
                throw new Error('Organization not found');
            }

            const team = await this.teamService.findOne({
                organization: {
                    uuid: organization.uuid,
                },
            });
            if (!team) {
                throw new Error('Team not found');
            }

            const teamMember = await this.teamMembersService.findOne({
                organization: {
                    uuid: organization.uuid,
                },
                user: {
                    uuid: targetUser.uuid,
                },
            });
            if (!teamMember) {
                throw new Error(
                    'Target user is not a member of the organization team',
                );
            }

            const previousRole = targetUser.role;

            const updatedUser = await this.usersService.update(
                { uuid: targetUserId },
                {
                    status,
                    role,
                },
            );

            if (!updatedUser) {
                throw new Error('Error updating user');
            }

            this.logger.log({
                message: 'User updated another user',
                context: UpdateAnotherUserUseCase.name,
                metadata: { userId, targetUserId, data },
            });

            if (role && previousRole !== role) {
                const actingUser = await this.usersService.findOne({
                    uuid: userId,
                });

                const logParams: UserRoleChangeLogParams = {
                    organizationAndTeamData: {
                        organizationId,
                        teamId: teamMember.team.uuid,
                    },
                    userInfo: {
                        userId,
                        userEmail: actingUser?.email,
                    },
                    actionType: ActionType.EDIT,
                    targetUserEmail: targetUser.email,
                    previousRole,
                    newRole: role,
                };

                this.eventEmitter.emit(
                    AuditLogEvents.USER_ROLE_CHANGE,
                    logParams,
                );

                // Notify that a member's role changed. The audience (org
                // owners) is declared as `defaultRoles` in the catalog and
                // resolved config-driven by the dispatcher — no recipients
                // here. Best-effort: emit failures don't break the flow.
                try {
                    await this.notificationService.emit({
                        event: NotificationEvent.ORG_ROLE_CHANGED,
                        payload: {
                            affectedUserEmail: targetUser.email ?? '',
                            previousRole: String(previousRole ?? 'unknown'),
                            newRole: String(role),
                            changedBy: actingUser?.email ?? userId,
                            organizationName: organization.name ?? '',
                        },
                        organizationId,
                    });
                } catch (notifyError) {
                    this.logger.error({
                        message:
                            'Failed to emit org.role_changed notification',
                        error:
                            notifyError instanceof Error
                                ? notifyError
                                : new Error(String(notifyError)),
                        context: UpdateAnotherUserUseCase.name,
                    });
                }
            }

            return updatedUser.toObject();
        } catch (error) {
            this.logger.error({
                message: 'Error updating another user',
                error,
                metadata: { userId, targetUserId, data },
                context: UpdateAnotherUserUseCase.name,
            });
            throw error;
        }
    }
}
