import { Module, forwardRef } from '@nestjs/common';

import { GlobalCacheModule } from '@libs/core/cache/cache.module';
import { AuthIntegrationModule } from '@libs/integrations/modules/authIntegration.module';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { IntegrationCoreModule } from '@libs/integrations/modules/integrations-core.module';
import { ForgejoService } from '../infrastructure/adapters/services/forgejo.service';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';

@Module({
    imports: [
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => IntegrationCoreModule),
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => GlobalCacheModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => McpCoreModule),
    ],
    providers: [ForgejoService],
    exports: [ForgejoService],
})
export class ForgejoModule {}
