import { Injectable } from '@nestjs/common';

import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { UserStatusDto } from '@libs/ee/codeReviewSettingsLog/dtos/user-status-change.dto';

@Injectable()
export class RegisterUserStatusLogUseCase implements IUseCase {
    constructor(private readonly eventEmitter: EventEmitter2) {}

    public async execute(userStatusDto: UserStatusDto): Promise<void> {
        const organizationId = userStatusDto.organizationId;

        this.eventEmitter.emit(AuditLogEvents.USER_STATUS, {
            organizationAndTeamData: {
                organizationId,
                teamId: userStatusDto.teamId || null,
            },
            userInfo: {
                userId: userStatusDto.editedBy?.userId || '',
                userEmail: userStatusDto.editedBy?.email || '',
            },
            userStatusChanges: [
                {
                    gitId: userStatusDto.gitId,
                    gitTool: userStatusDto.gitTool,
                    userName: userStatusDto.userName,
                    licenseStatus: userStatusDto.licenseStatus === 'active',
                },
            ],
            actionType: ActionType.EDIT,
        });
    }
}
