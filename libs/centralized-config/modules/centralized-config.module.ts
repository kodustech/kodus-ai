import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { ContextReferenceModule } from '@libs/code-review/modules/contextReference.module';
import { PromptsModule } from '@libs/code-review/modules/prompts.module';
import { PullRequestMessagesModule } from '@libs/code-review/modules/pullRequestMessages.module';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';
import { KodyRulesModule } from '@libs/kodyRules/modules/kodyRules.module';
import { OrganizationParametersModule } from '@libs/organization/modules/organizationParameters.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { Module, forwardRef } from '@nestjs/common';

import { CentralizedConfigDownloadUseCase } from '../application/use-cases/centralized-config-download.use-case';
import { CentralizedConfigInitUseCase } from '../application/use-cases/centralized-config-init.use-case';
import { CentralizedConfigSyncUseCase } from '../application/use-cases/centralized-config-sync.use-case';
import { CENTRALIZED_CONFIG_SERVICE_TOKEN } from '../domain/contracts/CentralizedConfigService.contract';
import { CentralizedConfigSyncListener } from '../infrastructure/adapters/listeners/centralized-config-sync.listener';
import { CentralizedConfigPrService } from '../infrastructure/adapters/services/centralized-config-pr.service';
import { CentralizedConfigService } from '../infrastructure/adapters/services/centralized-config.service';
import { CodeReviewConfigurationModule } from '@libs/code-review/modules/code-review-configuration.module';

@Module({
    imports: [
        forwardRef(() => ParametersModule),
        forwardRef(() => OrganizationParametersModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => PlatformModule),
        forwardRef(() => KodyRulesModule),
        forwardRef(() => PromptsModule),
        forwardRef(() => ContextReferenceModule),
        forwardRef(() => PullRequestMessagesModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => CodeReviewConfigurationModule),
    ],
    providers: [
        CentralizedConfigSyncUseCase,
        CentralizedConfigSyncListener,
        CentralizedConfigPrService,
        CentralizedConfigDownloadUseCase,
        CentralizedConfigInitUseCase,
        {
            provide: CENTRALIZED_CONFIG_SERVICE_TOKEN,
            useClass: CentralizedConfigService,
        },
    ],
    exports: [
        CentralizedConfigSyncUseCase,
        CentralizedConfigPrService,
        CentralizedConfigDownloadUseCase,
        CentralizedConfigInitUseCase,
        CENTRALIZED_CONFIG_SERVICE_TOKEN,
    ],
})
export class CentralizedConfigModule {}
