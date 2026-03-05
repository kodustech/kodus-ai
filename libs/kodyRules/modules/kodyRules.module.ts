import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { ContextReferenceModule } from '@libs/code-review/modules/contextReference.module';
import { PromptsModule } from '@libs/code-review/modules/prompts.module';
import { PullRequestsModule } from '@libs/code-review/modules/pull-requests.module';
import { GlobalCacheModule } from '@libs/core/cache/cache.module';
import { CodeReviewSettingsLogModule } from '@libs/ee/codeReviewSettingsLog/codeReviewSettingsLog.module';
import { KodyRulesRepository } from '@libs/ee/kodyRules/repository/kodyRules.repository';
import { KodyRulesValidationService } from '@libs/ee/kodyRules/service/kody-rules-validation.service';
import { KodyRulesService } from '@libs/ee/kodyRules/service/kodyRules.service';
import { LicenseModule } from '@libs/ee/license/license.module';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';

import { UserModule } from '@libs/identity/modules/user.module';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';
import { IntegrationModule } from '@libs/integrations/modules/integrations.module';
import { OrganizationModule } from '@libs/organization/modules/organization.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { PlatformCoreModule } from '@libs/platform/modules/platform-core.module';
import { AddLibraryKodyRulesUseCase } from '../application/use-cases/add-library-kody-rules.use-case';
import { ApplyPendingKodyRulesUseCase } from '../application/use-cases/apply-pending-kody-rules.use-case';
import { ChangeStatusKodyRulesUseCase } from '../application/use-cases/change-status-kody-rules.use-case';
import { CheckSyncStatusUseCase } from '../application/use-cases/check-sync-status.use-case';
import { ConvertPendingUpdatesToMemoriesUseCase } from '../application/use-cases/convert-pending-updates-to-memories.use-case';
import { CreateOrUpdateKodyRulesUseCase } from '../application/use-cases/create-or-update.use-case';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from '../application/use-cases/delete-rule-in-organization-by-id.use-case';
import { FastSyncIdeRulesUseCase } from '../application/use-cases/fast-sync-ide-rules.use-case';
import { FindByOrganizationIdKodyRulesUseCase } from '../application/use-cases/find-by-organization-id.use-case';
import { FindLibraryKodyRulesBucketsUseCase } from '../application/use-cases/find-library-kody-rules-buckets.use-case';
import { FindLibraryKodyRulesWithFeedbackUseCase } from '../application/use-cases/find-library-kody-rules-with-feedback.use-case';
import { FindLibraryKodyRulesUseCase } from '../application/use-cases/find-library-kody-rules.use-case';
import { FindRecommendedKodyRulesUseCase } from '../application/use-cases/find-recommended-kody-rules.use-case'; // Added
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from '../application/use-cases/find-rules-in-organization-by-filter.use-case';
import { FindSuggestionsByRuleUseCase } from '../application/use-cases/find-suggestions-by-rule.use-case';
import { GenerateKodyRulesUseCase } from '../application/use-cases/generate-kody-rules.use-case';
import { GetInheritedRulesKodyRulesUseCase } from '../application/use-cases/get-inherited-kody-rules.use-case';
import { GetRulesLimitStatusUseCase } from '../application/use-cases/get-rules-limit-status.use-case';
import { ImportFastKodyRulesUseCase } from '../application/use-cases/import-fast-kody-rules.use-case';
import { ResyncRulesFromIdeUseCase } from '../application/use-cases/resync-rules-from-ide.use-case';
import { RemoveRuleLikeUseCase } from '../application/use-cases/rule-like/remove-rule-like.use-case';
import { SetRuleLikeUseCase } from '../application/use-cases/rule-like/set-rule-like.use-case';
import { SendRulesNotificationUseCase } from '../application/use-cases/send-rules-notification.use-case';
import { SyncSelectedRepositoriesKodyRulesUseCase } from '../application/use-cases/sync-selected-repositories.use-case';
import { KODY_RULES_REPOSITORY_TOKEN } from '../domain/contracts/kodyRules.repository.contract';
import { KODY_RULES_SERVICE_TOKEN } from '../domain/contracts/kodyRules.service.contract';
import {
    KodyRulesModel,
    KodyRulesSchema,
} from '../infrastructure/adapters/repositories/schemas/kodyRules.model';
import { ExternalReferenceLoaderService } from '../infrastructure/adapters/services/externalReferenceLoader.service';
import { KodyRuleDependencyService } from '../infrastructure/adapters/services/kodyRulesDependency.service';
import { KodyRulesSyncService } from '../infrastructure/adapters/services/kodyRulesSync.service';
import { RuleLikeModule } from './ruleLike.module';

import { PermissionsModule } from '@libs/identity/modules/permissions.module';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';
import { KodyRulesSyncListener } from '../infrastructure/adapters/listeners/kody-rules-sync.listener';

@Module({
    imports: [
        MongooseModule.forFeature([
            {
                name: KodyRulesModel.name,
                schema: KodyRulesSchema,
            },
        ]),
        forwardRef(() => PlatformCoreModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => UserModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => CodeReviewSettingsLogModule),
        forwardRef(() => RuleLikeModule),
        forwardRef(() => LicenseModule),
        forwardRef(() => PullRequestsModule),
        forwardRef(() => PromptsModule),
        forwardRef(() => ContextReferenceModule),
        GlobalCacheModule,
        forwardRef(() => PermissionValidationModule),
        PermissionsModule,
        forwardRef(() => McpCoreModule),
    ],
    providers: [
        {
            provide: KODY_RULES_REPOSITORY_TOKEN,
            useClass: KodyRulesRepository,
        },
        {
            provide: KODY_RULES_SERVICE_TOKEN,
            useClass: KodyRulesService,
        },
        GenerateKodyRulesUseCase,
        ApplyPendingKodyRulesUseCase,
        FindByOrganizationIdKodyRulesUseCase,
        FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
        ChangeStatusKodyRulesUseCase,
        CreateOrUpdateKodyRulesUseCase,
        SendRulesNotificationUseCase,
        SyncSelectedRepositoriesKodyRulesUseCase,
        KodyRulesValidationService,
        KodyRulesSyncService,
        KodyRuleDependencyService,
        ExternalReferenceLoaderService,
        AddLibraryKodyRulesUseCase,
        CheckSyncStatusUseCase,
        DeleteRuleInOrganizationByIdKodyRulesUseCase,
        FastSyncIdeRulesUseCase,
        FindLibraryKodyRulesBucketsUseCase,
        FindLibraryKodyRulesWithFeedbackUseCase,
        FindLibraryKodyRulesUseCase,
        FindSuggestionsByRuleUseCase,
        GetInheritedRulesKodyRulesUseCase,
        GetRulesLimitStatusUseCase,
        ImportFastKodyRulesUseCase,
        ResyncRulesFromIdeUseCase,
        RemoveRuleLikeUseCase,
        SetRuleLikeUseCase,
        KodyRulesSyncListener,
        FindRecommendedKodyRulesUseCase, // Added
        ConvertPendingUpdatesToMemoriesUseCase,
    ],
    exports: [
        KODY_RULES_REPOSITORY_TOKEN,
        KODY_RULES_SERVICE_TOKEN,
        GenerateKodyRulesUseCase,
        ApplyPendingKodyRulesUseCase,
        FindByOrganizationIdKodyRulesUseCase,
        FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
        ChangeStatusKodyRulesUseCase,
        CreateOrUpdateKodyRulesUseCase,
        SendRulesNotificationUseCase,
        KodyRulesValidationService,
        KodyRulesSyncService,
        KodyRuleDependencyService,
        ExternalReferenceLoaderService,
        SyncSelectedRepositoriesKodyRulesUseCase,
        AddLibraryKodyRulesUseCase,
        CheckSyncStatusUseCase,
        DeleteRuleInOrganizationByIdKodyRulesUseCase,
        FastSyncIdeRulesUseCase,
        FindLibraryKodyRulesBucketsUseCase,
        FindLibraryKodyRulesWithFeedbackUseCase,
        FindLibraryKodyRulesUseCase,
        FindSuggestionsByRuleUseCase,
        GetInheritedRulesKodyRulesUseCase,
        GetRulesLimitStatusUseCase,
        ImportFastKodyRulesUseCase,
        ResyncRulesFromIdeUseCase,
        RemoveRuleLikeUseCase,
        SetRuleLikeUseCase,
        FindRecommendedKodyRulesUseCase, // Added
        ConvertPendingUpdatesToMemoriesUseCase,
    ],
})
export class KodyRulesModule {}
