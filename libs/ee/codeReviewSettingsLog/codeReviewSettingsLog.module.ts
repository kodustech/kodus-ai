import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { ContextResolutionModule } from '@libs/core/context-resolution/context-resolution.module';
import { LicenseModule } from '@libs/ee/license/license.module';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { PermissionsModule } from '@libs/identity/modules/permissions.module';
import { FindCodeReviewSettingsLogsUseCase } from './application/use-cases/find-code-review-settings-logs.use-case';
import { RegisterUserStatusLogUseCase } from './application/use-cases/register-use-status-log.use-case';
import { CODE_REVIEW_SETTINGS_LOG_REPOSITORY_TOKEN } from './domain/contracts/codeReviewSettingsLog.repository.contract';
import { CODE_REVIEW_SETTINGS_LOG_SERVICE_TOKEN } from './domain/contracts/codeReviewSettingsLog.service.contract';
import { CodeReviewSettingsLogRepository } from './infrastructure/adapters/repository/codeReviewSettingsLog.repository';
import {
    CodeReviewSettingsLogModel,
    CodeReviewSettingsLogSchema,
} from './infrastructure/adapters/repository/schemas/codeReviewSettingsLog.model';
import { CodeReviewConfigLogHandler } from './infrastructure/adapters/services/codeReviewConfigLog.handler';
import { CodeReviewSettingsLogService } from './infrastructure/adapters/services/codeReviewSettingsLog.service';
import { IntegrationLogHandler } from './infrastructure/adapters/services/integrationLog.handler';
import { KodyRulesLogHandler } from './infrastructure/adapters/services/kodyRulesLog.handler';
import { PullRequestMessagesLogHandler } from './infrastructure/adapters/services/pullRequestMessageLog.handler';
import { RepositoriesLogHandler } from './infrastructure/adapters/services/repositoriesLog.handler';
import { UnifiedLogHandler } from './infrastructure/adapters/services/unifiedLog.handler';
import { UserStatusLogHandler } from './infrastructure/adapters/services/userStatusLog.handler';
import { UserInviteLogHandler } from './infrastructure/adapters/services/userInviteLog.handler';
import { UserManagementLogHandler } from './infrastructure/adapters/services/userManagementLog.handler';
import { OrgSettingsLogHandler } from './infrastructure/adapters/services/orgSettingsLog.handler';
import { CliKeyLogHandler } from './infrastructure/adapters/services/cliKeyLog.handler';
import { AuditLogListener } from './listeners/audit-log.listener';

@Module({
    imports: [
        MongooseModule.forFeature([
            {
                name: CodeReviewSettingsLogModel.name,
                schema: CodeReviewSettingsLogSchema,
            },
        ]),
        forwardRef(() => PermissionValidationModule),
        ContextResolutionModule,
        forwardRef(() => PermissionsModule),
        LicenseModule,
    ],
    providers: [
        {
            provide: CODE_REVIEW_SETTINGS_LOG_REPOSITORY_TOKEN,
            useClass: CodeReviewSettingsLogRepository,
        },
        {
            provide: CODE_REVIEW_SETTINGS_LOG_SERVICE_TOKEN,
            useClass: CodeReviewSettingsLogService,
        },
        CodeReviewConfigLogHandler,
        IntegrationLogHandler,
        KodyRulesLogHandler,
        PullRequestMessagesLogHandler,
        RepositoriesLogHandler,
        UnifiedLogHandler,
        UserStatusLogHandler,
        UserInviteLogHandler,
        UserManagementLogHandler,
        OrgSettingsLogHandler,
        CliKeyLogHandler,
        RegisterUserStatusLogUseCase,
        FindCodeReviewSettingsLogsUseCase,
        AuditLogListener,
    ],
    exports: [
        CODE_REVIEW_SETTINGS_LOG_SERVICE_TOKEN,
        CODE_REVIEW_SETTINGS_LOG_REPOSITORY_TOKEN,
        RegisterUserStatusLogUseCase,
        FindCodeReviewSettingsLogsUseCase,
    ],
})
export class CodeReviewSettingsLogModule {}
