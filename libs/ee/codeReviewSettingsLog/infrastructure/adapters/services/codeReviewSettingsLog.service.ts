import { Inject, Injectable } from '@nestjs/common';

// Handlers
import { KodyRuleLogParams, KodyRulesLogHandler } from './kodyRulesLog.handler';
import {
    CodeReviewConfigLogHandler,
    CodeReviewConfigLogParams,
} from './codeReviewConfigLog.handler';
import {
    RepositoriesLogHandler,
    RepositoriesLogParams,
    RepositoryConfigRemovalParams,
    DirectoryConfigRemovalParams,
} from './repositoriesLog.handler';
import {
    IntegrationLogHandler,
    IntegrationLogParams,
} from './integrationLog.handler';
import {
    UserStatusLogHandler,
    UserStatusLogParams,
} from './userStatusLog.handler';
import {
    PullRequestMessagesLogHandler,
    PullRequestMessagesLogParams,
} from './pullRequestMessageLog.handler';
import {
    UserInviteLogHandler,
    UserInviteLogParams,
} from './userInviteLog.handler';
import {
    UserManagementLogHandler,
    UserRoleChangeLogParams,
    UserRepoAccessLogParams,
} from './userManagementLog.handler';
import {
    OrgSettingsLogHandler,
    OrgSettingsLogParams,
} from './orgSettingsLog.handler';
import { CliKeyLogHandler, CliKeyLogParams } from './cliKeyLog.handler';
import { ICodeReviewSettingsLogService } from '@libs/ee/codeReviewSettingsLog/domain/contracts/codeReviewSettingsLog.service.contract';
import {
    CODE_REVIEW_SETTINGS_LOG_REPOSITORY_TOKEN,
    ICodeReviewSettingsLogRepository,
} from '@libs/ee/codeReviewSettingsLog/domain/contracts/codeReviewSettingsLog.repository.contract';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ICodeReviewSettingsLog } from '@libs/ee/codeReviewSettingsLog/domain/interfaces/codeReviewSettingsLog.interface';
import { CodeReviewSettingsLogEntity } from '@libs/ee/codeReviewSettingsLog/domain/entities/codeReviewSettingsLog.entity';

@Injectable()
export class CodeReviewSettingsLogService implements ICodeReviewSettingsLogService {
    constructor(
        @Inject(CODE_REVIEW_SETTINGS_LOG_REPOSITORY_TOKEN)
        private readonly codeReviewSettingsLogRepository: ICodeReviewSettingsLogRepository,

        private readonly permissionValidationService: PermissionValidationService,
        private readonly kodyRulesLogHandler: KodyRulesLogHandler,
        private readonly codeReviewConfigLogHandler: CodeReviewConfigLogHandler,
        private readonly repositoriesLogHandler: RepositoriesLogHandler,
        private readonly integrationLogHandler: IntegrationLogHandler,
        private readonly userStatusLogHandler: UserStatusLogHandler,
        private readonly pullRequestMessagesLogHandler: PullRequestMessagesLogHandler,
        private readonly userInviteLogHandler: UserInviteLogHandler,
        private readonly userManagementLogHandler: UserManagementLogHandler,
        private readonly orgSettingsLogHandler: OrgSettingsLogHandler,
        private readonly cliKeyLogHandler: CliKeyLogHandler,
    ) {}

    /**
     * Verifica se a organização tem permissão para usar audit logs (feature enterprise)
     * Audit logs só estão disponíveis para planos MANAGED/ENTERPRISE
     * NÃO disponível para: FREE, BYOK, Self-hosted
     */
    private async shouldAllowAuditLogs(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<boolean> {
        const shouldLimit =
            await this.permissionValidationService.shouldLimitResources(
                organizationAndTeamData,
                CodeReviewSettingsLogService.name,
            );

        // Se limita recursos (FREE/BYOK/sem licença) = NÃO permite audit logs
        // Se NÃO limita (MANAGED/ENTERPRISE) = PERMITE audit logs
        return !shouldLimit;
    }

    async create(
        codeReviewSettingsLog: Omit<ICodeReviewSettingsLog, 'uuid'>,
    ): Promise<CodeReviewSettingsLogEntity> {
        return this.codeReviewSettingsLogRepository.create(
            codeReviewSettingsLog,
        );
    }

    async find(
        filter?: Partial<ICodeReviewSettingsLog>,
    ): Promise<CodeReviewSettingsLogEntity[]> {
        return this.codeReviewSettingsLogRepository.find(filter);
    }

    // Kody Rules
    public async registerKodyRulesLog(
        params: KodyRuleLogParams,
    ): Promise<void> {
        const canAudit = await this.shouldAllowAuditLogs(
            params.organizationAndTeamData,
        );
        if (!canAudit) {
            return;
        }

        await this.kodyRulesLogHandler.logKodyRuleAction(params);
    }

    // Code Review Config
    public async registerCodeReviewConfigLog(
        params: CodeReviewConfigLogParams,
    ): Promise<void> {
        const canAudit = await this.shouldAllowAuditLogs(
            params.organizationAndTeamData,
        );
        if (!canAudit) {
            return;
        }

        await this.codeReviewConfigLogHandler.logCodeReviewConfig(params);
    }

    // Repositories
    public async registerRepositoriesLog(
        params: RepositoriesLogParams,
    ): Promise<void> {
        const canAudit = await this.shouldAllowAuditLogs(
            params.organizationAndTeamData,
        );
        if (!canAudit) {
            return;
        }

        await this.repositoriesLogHandler.logRepositoriesAction(params);
    }

    public async registerRepositoryConfigurationRemoval(
        params: RepositoryConfigRemovalParams,
    ): Promise<void> {
        const canAudit = await this.shouldAllowAuditLogs(
            params.organizationAndTeamData,
        );
        if (!canAudit) {
            return;
        }

        await this.repositoriesLogHandler.logRepositoryConfigurationRemoval(
            params,
        );
    }

    public async registerDirectoryConfigurationRemoval(
        params: DirectoryConfigRemovalParams,
    ): Promise<void> {
        const canAudit = await this.shouldAllowAuditLogs(
            params.organizationAndTeamData,
        );
        if (!canAudit) {
            return;
        }

        await this.repositoriesLogHandler.logDirectoryConfigurationRemoval(
            params,
        );
    }

    // Integrations
    public async registerIntegrationLog(
        params: IntegrationLogParams,
    ): Promise<void> {
        const canAudit = await this.shouldAllowAuditLogs(
            params.organizationAndTeamData,
        );
        if (!canAudit) {
            return;
        }

        await this.integrationLogHandler.logIntegrationAction(params);
    }

    // User Status
    public async registerUserStatusLog(
        params: UserStatusLogParams,
    ): Promise<void> {
        const canAudit = await this.shouldAllowAuditLogs(
            params.organizationAndTeamData,
        );
        if (!canAudit) {
            return;
        }

        await this.userStatusLogHandler.logUserStatusChanges(params);
    }

    // Pull Request Messages
    public async registerPullRequestMessagesLog(
        params: PullRequestMessagesLogParams,
    ): Promise<void> {
        const canAudit = await this.shouldAllowAuditLogs(
            params.organizationAndTeamData,
        );
        if (!canAudit) {
            return;
        }

        await this.pullRequestMessagesLogHandler.logPullRequestMessagesAction(
            params,
        );
    }

    // User Invite
    public async registerUserInviteLog(
        params: UserInviteLogParams,
    ): Promise<void> {
        const canAudit = await this.shouldAllowAuditLogs(
            params.organizationAndTeamData,
        );
        if (!canAudit) {
            return;
        }

        await this.userInviteLogHandler.logUserInviteAction(params);
    }

    // User Role Change
    public async registerUserRoleChangeLog(
        params: UserRoleChangeLogParams,
    ): Promise<void> {
        const canAudit = await this.shouldAllowAuditLogs(
            params.organizationAndTeamData,
        );
        if (!canAudit) {
            return;
        }

        await this.userManagementLogHandler.logUserRoleChange(params);
    }

    // User Repository Access
    public async registerUserRepoAccessLog(
        params: UserRepoAccessLogParams,
    ): Promise<void> {
        const canAudit = await this.shouldAllowAuditLogs(
            params.organizationAndTeamData,
        );
        if (!canAudit) {
            return;
        }

        await this.userManagementLogHandler.logUserRepoAccessChange(params);
    }

    // Organization Settings (Auto-Join, Timezone)
    public async registerOrgSettingsLog(
        params: OrgSettingsLogParams,
    ): Promise<void> {
        const canAudit = await this.shouldAllowAuditLogs(
            params.organizationAndTeamData,
        );
        if (!canAudit) {
            return;
        }

        await this.orgSettingsLogHandler.logOrgSettingsChange(params);
    }

    // CLI Keys
    public async registerCliKeyLog(params: CliKeyLogParams): Promise<void> {
        const canAudit = await this.shouldAllowAuditLogs(
            params.organizationAndTeamData,
        );
        if (!canAudit) {
            return;
        }

        await this.cliKeyLogHandler.logCliKeyAction(params);
    }
}
