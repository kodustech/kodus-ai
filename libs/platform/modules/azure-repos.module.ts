import { Module, forwardRef } from '@nestjs/common';

import { AuthIntegrationModule } from '@libs/integrations/modules/authIntegration.module';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { IntegrationCoreModule } from '@libs/integrations/modules/integrations-core.module';
import { AzureReposService } from '../infrastructure/adapters/services/azureRepos/azureRepos.service';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';
import { AzureReposRequestHelper } from '../infrastructure/adapters/services/azureRepos/azure-repos-request-helper';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';

@Module({
    imports: [
        forwardRef(() => TeamModule),
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => IntegrationCoreModule),
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => McpCoreModule),
    ],
    providers: [AzureReposService, AzureReposRequestHelper],
    exports: [AzureReposService, AzureReposRequestHelper],
})
export class AzureReposModule {}
