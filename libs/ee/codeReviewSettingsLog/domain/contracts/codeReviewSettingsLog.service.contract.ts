import { CodeReviewConfigLogParams } from '../../infrastructure/adapters/services/codeReviewConfigLog.handler';
import { IntegrationLogParams } from '../../infrastructure/adapters/services/integrationLog.handler';
import { KodyRuleLogParams } from '../../infrastructure/adapters/services/kodyRulesLog.handler';
import { PullRequestMessagesLogParams } from '../../infrastructure/adapters/services/pullRequestMessageLog.handler';
import {
    DirectoryConfigRemovalParams,
    RepositoriesLogParams,
    RepositoryConfigRemovalParams,
} from '../../infrastructure/adapters/services/repositoriesLog.handler';
import { UserStatusLogParams } from '../../infrastructure/adapters/services/userStatusLog.handler';
import { UserInviteLogParams } from '../../infrastructure/adapters/services/userInviteLog.handler';
import {
    UserRoleChangeLogParams,
    UserRepoAccessLogParams,
} from '../../infrastructure/adapters/services/userManagementLog.handler';
import { OrgSettingsLogParams } from '../../infrastructure/adapters/services/orgSettingsLog.handler';
import { CliKeyLogParams } from '../../infrastructure/adapters/services/cliKeyLog.handler';
import { ICodeReviewSettingsLogRepository } from './codeReviewSettingsLog.repository.contract';

export const CODE_REVIEW_SETTINGS_LOG_SERVICE_TOKEN = Symbol(
    'CodeReviewSettingsLogService',
);

export interface ICodeReviewSettingsLogService extends ICodeReviewSettingsLogRepository {
    registerCodeReviewConfigLog(
        params: CodeReviewConfigLogParams,
    ): Promise<void>;
    registerKodyRulesLog(params: KodyRuleLogParams): Promise<void>;
    registerRepositoriesLog(params: RepositoriesLogParams): Promise<void>;
    registerRepositoryConfigurationRemoval(
        params: RepositoryConfigRemovalParams,
    ): Promise<void>;
    registerDirectoryConfigurationRemoval(
        params: DirectoryConfigRemovalParams,
    ): Promise<void>;
    registerIntegrationLog(params: IntegrationLogParams): Promise<void>;
    registerUserStatusLog(params: UserStatusLogParams): Promise<void>;
    registerPullRequestMessagesLog(
        params: PullRequestMessagesLogParams,
    ): Promise<void>;
    registerUserInviteLog(params: UserInviteLogParams): Promise<void>;
    registerUserRoleChangeLog(params: UserRoleChangeLogParams): Promise<void>;
    registerUserRepoAccessLog(params: UserRepoAccessLogParams): Promise<void>;
    registerOrgSettingsLog(params: OrgSettingsLogParams): Promise<void>;
    registerCliKeyLog(params: CliKeyLogParams): Promise<void>;
}
