import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { createLogger } from '@kodus/flow';

import { AuditLogEvents } from '../events/audit-log.events';
import {
    CODE_REVIEW_SETTINGS_LOG_SERVICE_TOKEN,
    ICodeReviewSettingsLogService,
} from '../domain/contracts/codeReviewSettingsLog.service.contract';
import { CodeReviewConfigLogParams } from '../infrastructure/adapters/services/codeReviewConfigLog.handler';
import { KodyRuleLogParams } from '../infrastructure/adapters/services/kodyRulesLog.handler';
import {
    RepositoriesLogParams,
    RepositoryConfigRemovalParams,
    DirectoryConfigRemovalParams,
} from '../infrastructure/adapters/services/repositoriesLog.handler';
import { IntegrationLogParams } from '../infrastructure/adapters/services/integrationLog.handler';
import { UserStatusLogParams } from '../infrastructure/adapters/services/userStatusLog.handler';
import { PullRequestMessagesLogParams } from '../infrastructure/adapters/services/pullRequestMessageLog.handler';
import { UserInviteLogParams } from '../infrastructure/adapters/services/userInviteLog.handler';
import {
    UserRoleChangeLogParams,
    UserRepoAccessLogParams,
} from '../infrastructure/adapters/services/userManagementLog.handler';
import { OrgSettingsLogParams } from '../infrastructure/adapters/services/orgSettingsLog.handler';
import { CliKeyLogParams } from '../infrastructure/adapters/services/cliKeyLog.handler';

@Injectable()
export class AuditLogListener {
    private readonly logger = createLogger(AuditLogListener.name);

    constructor(
        @Inject(CODE_REVIEW_SETTINGS_LOG_SERVICE_TOKEN)
        private readonly codeReviewSettingsLogService: ICodeReviewSettingsLogService,
    ) {}

    @OnEvent(AuditLogEvents.CODE_REVIEW_CONFIG)
    async handleCodeReviewConfig(params: CodeReviewConfigLogParams) {
        try {
            await this.codeReviewSettingsLogService.registerCodeReviewConfigLog(
                params,
            );
        } catch (error) {
            this.logError('code review config', error, params);
        }
    }

    @OnEvent(AuditLogEvents.KODY_RULES)
    async handleKodyRules(params: KodyRuleLogParams) {
        try {
            await this.codeReviewSettingsLogService.registerKodyRulesLog(
                params,
            );
        } catch (error) {
            this.logError('kody rules', error, params);
        }
    }

    @OnEvent(AuditLogEvents.REPOSITORIES)
    async handleRepositories(params: RepositoriesLogParams) {
        try {
            await this.codeReviewSettingsLogService.registerRepositoriesLog(
                params,
            );
        } catch (error) {
            this.logError('repositories', error, params);
        }
    }

    @OnEvent(AuditLogEvents.REPOSITORY_CONFIG_REMOVAL)
    async handleRepositoryConfigRemoval(params: RepositoryConfigRemovalParams) {
        try {
            await this.codeReviewSettingsLogService.registerRepositoryConfigurationRemoval(
                params,
            );
        } catch (error) {
            this.logError('repository config removal', error, params);
        }
    }

    @OnEvent(AuditLogEvents.DIRECTORY_CONFIG_REMOVAL)
    async handleDirectoryConfigRemoval(params: DirectoryConfigRemovalParams) {
        try {
            await this.codeReviewSettingsLogService.registerDirectoryConfigurationRemoval(
                params,
            );
        } catch (error) {
            this.logError('directory config removal', error, params);
        }
    }

    @OnEvent(AuditLogEvents.INTEGRATION)
    async handleIntegration(params: IntegrationLogParams) {
        try {
            await this.codeReviewSettingsLogService.registerIntegrationLog(
                params,
            );
        } catch (error) {
            this.logError('integration', error, params);
        }
    }

    @OnEvent(AuditLogEvents.USER_STATUS)
    async handleUserStatus(params: UserStatusLogParams) {
        try {
            await this.codeReviewSettingsLogService.registerUserStatusLog(
                params,
            );
        } catch (error) {
            this.logError('user status', error, params);
        }
    }

    @OnEvent(AuditLogEvents.PR_MESSAGES)
    async handlePullRequestMessages(params: PullRequestMessagesLogParams) {
        try {
            await this.codeReviewSettingsLogService.registerPullRequestMessagesLog(
                params,
            );
        } catch (error) {
            this.logError('pull request messages', error, params);
        }
    }

    @OnEvent(AuditLogEvents.USER_INVITE)
    async handleUserInvite(params: UserInviteLogParams) {
        try {
            await this.codeReviewSettingsLogService.registerUserInviteLog(
                params,
            );
        } catch (error) {
            this.logError('user invite', error, params);
        }
    }

    @OnEvent(AuditLogEvents.USER_ROLE_CHANGE)
    async handleUserRoleChange(params: UserRoleChangeLogParams) {
        try {
            await this.codeReviewSettingsLogService.registerUserRoleChangeLog(
                params,
            );
        } catch (error) {
            this.logError('user role change', error, params);
        }
    }

    @OnEvent(AuditLogEvents.USER_REPO_ACCESS)
    async handleUserRepoAccess(params: UserRepoAccessLogParams) {
        try {
            await this.codeReviewSettingsLogService.registerUserRepoAccessLog(
                params,
            );
        } catch (error) {
            this.logError('user repo access', error, params);
        }
    }

    @OnEvent(AuditLogEvents.ORG_SETTINGS)
    async handleOrgSettings(params: OrgSettingsLogParams) {
        try {
            await this.codeReviewSettingsLogService.registerOrgSettingsLog(
                params,
            );
        } catch (error) {
            this.logError('org settings', error, params);
        }
    }

    @OnEvent(AuditLogEvents.CLI_KEY)
    async handleCliKey(params: CliKeyLogParams) {
        try {
            await this.codeReviewSettingsLogService.registerCliKeyLog(params);
        } catch (error) {
            this.logError('cli key', error, params);
        }
    }

    private logError(context: string, error: any, params: any) {
        this.logger.error({
            message: `Error processing audit log event for ${context}`,
            context: AuditLogListener.name,
            error,
            metadata: {
                organizationId: params?.organizationAndTeamData?.organizationId,
            },
        });
    }
}
