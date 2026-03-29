import { Module, forwardRef } from '@nestjs/common';

import { GlobalCacheModule } from '@libs/core/cache/cache.module';
import { AuthIntegrationModule } from '@libs/integrations/modules/authIntegration.module';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { IntegrationCoreModule } from '@libs/integrations/modules/integrations-core.module';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';
import { GithubIssuesService } from '../infrastructure/adapters/services/github/github-issues.service';
import { GithubService as GitHubService } from '../infrastructure/adapters/services/github/github.service';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';

@Module({
    imports: [
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => IntegrationCoreModule),
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => GlobalCacheModule),
        forwardRef(() => CodebaseModule),
        McpCoreModule,
    ],
    providers: [GitHubService, GithubIssuesService],
    exports: [GitHubService, GithubIssuesService],
})
export class GithubModule { }
