import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { createLogger } from '@kodus/flow';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@libs/organization/domain/teamMembers/contracts/teamMembers.service.contracts';
import {
    IMembers,
    IUpdateOrCreateMembersResponse,
} from '@libs/organization/domain/teamMembers/interfaces/teamMembers.interface';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { UserInviteLogParams } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/userInviteLog.handler';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';

export class CreateOrUpdateTeamMembersUseCase implements IUseCase {
    private readonly logger = createLogger(
        CreateOrUpdateTeamMembersUseCase.name,
    );

    constructor(
        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: ITeamMemberService,

        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly eventEmitter: EventEmitter2,
    ) {}
    public async execute(teamId: string, members: IMembers[]): Promise<any> {
        try {
            const result: IUpdateOrCreateMembersResponse =
                await this.teamMembersService.updateOrCreateMembers(
                    members,
                    {
                        organizationId: this.request.user.organization.uuid,
                        teamId,
                    },
                    this.request.user.email,
                );

            if (result?.results?.length > 0) {
                try {
                    const logParams: UserInviteLogParams = {
                        organizationAndTeamData: {
                            organizationId: this.request.user.organization.uuid,
                            teamId,
                        },
                        userInfo: {
                            userId: this.request.user.uuid,
                            userEmail: this.request.user.email,
                        },
                        actionType: ActionType.ADD,
                        invitedUsers: result.results.map((r) => ({
                            email: r.email,
                            status: r.status,
                        })),
                    };

                    this.eventEmitter.emit(
                        AuditLogEvents.USER_INVITE,
                        logParams,
                    );
                } catch (logError) {
                    this.logger.warn({
                        message: 'Failed to emit user invite audit log event',
                        error: logError,
                        context: CreateOrUpdateTeamMembersUseCase.name,
                    });
                }
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error while creating team members',
                context: CreateOrUpdateTeamMembersUseCase.name,
                serviceName: 'GetOrganizationMetricsByIdUseCase',
                error: error,
                metadata: {
                    organizationId: this.request.user.organization.uuid,
                },
            });
        }
    }
}
