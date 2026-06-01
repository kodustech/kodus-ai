import { Module, forwardRef } from '@nestjs/common';

import { BitbucketService } from '../infrastructure/adapters/services/bitbucket.service';
import { IntegrationCoreModule } from '@libs/integrations/modules/integrations-core.module';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { AuthIntegrationModule } from '@libs/integrations/modules/authIntegration.module';
import { GlobalCacheModule } from '@libs/core/cache/cache.module';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { BitbucketCloudService } from '../infrastructure/adapters/services/bitbucket/bitbucket-cloud.service';
import { BitbucketDataCenterService } from '../infrastructure/adapters/services/bitbucket/bitbucket-data-center.service';

@Module({
    imports: [
        forwardRef(() => IntegrationCoreModule),
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => GlobalCacheModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => McpCoreModule),
    ],
    providers: [
        BitbucketService,
        BitbucketCloudService,
        BitbucketDataCenterService,
    ],
    exports: [BitbucketService],
})
export class BitbucketModule {}
