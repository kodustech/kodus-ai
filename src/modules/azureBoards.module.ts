import { Module, forwardRef } from '@nestjs/common';
import { AuthIntegrationModule } from './authIntegration.module';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';

import { AZURE_BOARDS_SERVICE_TOKEN } from '@/core/domain/azureBoards/azureBoards.service.contract';
import { AzureBoardsService } from '@/core/infrastructure/adapters/services/azureBoards.service';
import { TeamsModule } from './team.module';

@Module({
    imports: [
        forwardRef(() => IntegrationModule),
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        TeamsModule,
    ],
    providers: [
        {
            provide: AZURE_BOARDS_SERVICE_TOKEN,
            useClass: AzureBoardsService,
        },
    ],
    exports: [AZURE_BOARDS_SERVICE_TOKEN],
})
export class AzureBoardsModule {}
