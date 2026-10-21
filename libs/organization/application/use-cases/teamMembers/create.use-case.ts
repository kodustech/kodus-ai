import { Inject, NotFoundException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { createLogger } from '@libs/core/log/logger';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
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
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

export class CreateOrUpdateTeamMembersUseCase implements IUseCase {
    private readonly logger = createLogger(
        CreateOrUpdateTeamMembersUseCase.name,
    );

    constructor(
        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: ITeamMemberService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly eventEmitter: EventEmitter2,

        private readonly telemetry: TelemetryService,
    ) {}
    public async execute(teamId: string, members: IMembers[]): Promise<any> {
        // `teamId` comes from the request body and the route guard only
        // checks the caller's role, so without this an owner could attach
        // members to a team of another organization. Checked before the
        // try below, whose catch swallows errors into an empty response.
        const teamOrganizationId =
            await this.teamService.findOneOrganizationIdByTeamId(teamId);
        if (
            !teamOrganizationId ||
            teamOrganizationId !== this.request.user?.organization?.uuid
        ) {
            throw new NotFoundException('Team not found');
        }

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

                void this.telemetry.memberInvited({
                    organizationId: this.request.user.organization.uuid,
                    teamId,
                    actorUserId: this.request.user.uuid,
                    invitedCount: result.results.length,
                });
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
