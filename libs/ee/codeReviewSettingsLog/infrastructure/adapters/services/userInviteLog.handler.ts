import { Injectable } from '@nestjs/common';
import {
    BaseLogParams,
    ChangedDataToExport,
    UnifiedLogHandler,
} from './unifiedLog.handler';
import {
    ActionType,
    ConfigLevel,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';

export interface InvitedUser {
    email: string;
    status: 'invite_sent' | 'user_already_registered_in_other_organization';
}

export interface UserInviteLogParams extends BaseLogParams {
    invitedUsers: InvitedUser[];
}

@Injectable()
export class UserInviteLogHandler {
    constructor(private readonly unifiedLogHandler: UnifiedLogHandler) {}

    public async logUserInviteAction(
        params: UserInviteLogParams,
    ): Promise<void> {
        const { invitedUsers, userInfo } = params;

        const successfulInvites = invitedUsers.filter(
            (u) => u.status === 'invite_sent',
        );

        if (successfulInvites.length === 0) {
            return;
        }

        const changedData = this.generateInviteChangedData(
            successfulInvites,
            userInfo.userEmail,
        );

        await this.unifiedLogHandler.saveLogEntry({
            ...params,
            actionType: ActionType.ADD,
            configLevel: ConfigLevel.GLOBAL,
            repository: undefined,
            changedData,
        });
    }

    private generateInviteChangedData(
        invitedUsers: InvitedUser[],
        userEmail: string,
    ): ChangedDataToExport[] {
        return invitedUsers.map((invitedUser) => ({
            actionDescription: 'User Invited',
            previousValue: null,
            currentValue: {
                email: invitedUser.email,
            },
            description: `User ${userEmail} invited "${invitedUser.email}" to the workspace`,
        }));
    }
}
