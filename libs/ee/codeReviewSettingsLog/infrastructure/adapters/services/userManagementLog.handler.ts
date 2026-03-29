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

export interface UserRoleChangeLogParams extends BaseLogParams {
    targetUserEmail: string;
    previousRole: string;
    newRole: string;
}

export interface UserRepoAccessLogParams extends BaseLogParams {
    targetUserEmail: string;
    addedRepositories: Array<{ id: string; name: string }>;
    removedRepositories: Array<{ id: string; name: string }>;
}

@Injectable()
export class UserManagementLogHandler {
    constructor(private readonly unifiedLogHandler: UnifiedLogHandler) {}

    public async logUserRoleChange(
        params: UserRoleChangeLogParams,
    ): Promise<void> {
        const { targetUserEmail, previousRole, newRole, userInfo } = params;

        if (previousRole === newRole) {
            return;
        }

        const changedData: ChangedDataToExport[] = [
            {
                actionDescription: 'User Role Changed',
                previousValue: { role: previousRole },
                currentValue: { role: newRole },
                description: `User ${userInfo.userEmail} changed role of "${targetUserEmail}" from ${this.formatRole(previousRole)} to ${this.formatRole(newRole)}`,
            },
        ];

        await this.unifiedLogHandler.saveLogEntry({
            ...params,
            actionType: ActionType.EDIT,
            configLevel: ConfigLevel.GLOBAL,
            repository: undefined,
            changedData,
        });
    }

    public async logUserRepoAccessChange(
        params: UserRepoAccessLogParams,
    ): Promise<void> {
        const {
            targetUserEmail,
            addedRepositories,
            removedRepositories,
            userInfo,
        } = params;

        if (
            addedRepositories.length === 0 &&
            removedRepositories.length === 0
        ) {
            return;
        }

        const changedData: ChangedDataToExport[] = [];

        for (const repo of addedRepositories) {
            changedData.push({
                actionDescription: 'Repository Access Granted',
                previousValue: null,
                currentValue: {
                    repositoryId: repo.id,
                    repositoryName: repo.name,
                    targetUserEmail,
                },
                description: `User ${userInfo.userEmail} granted "${targetUserEmail}" access to repository "${repo.name}"`,
            });
        }

        for (const repo of removedRepositories) {
            changedData.push({
                actionDescription: 'Repository Access Revoked',
                previousValue: {
                    repositoryId: repo.id,
                    repositoryName: repo.name,
                    targetUserEmail,
                },
                currentValue: null,
                description: `User ${userInfo.userEmail} revoked "${targetUserEmail}" access to repository "${repo.name}"`,
            });
        }

        await this.unifiedLogHandler.saveLogEntry({
            ...params,
            actionType: ActionType.EDIT,
            configLevel: ConfigLevel.GLOBAL,
            repository: undefined,
            changedData,
        });
    }

    private formatRole(role: string): string {
        const roleLabels: Record<string, string> = {
            owner: 'Owner',
            billing_manager: 'Billing Manager',
            repo_admin: 'Repo Admin',
            contributor: 'Contributor',
        };
        return roleLabels[role] || role;
    }
}
