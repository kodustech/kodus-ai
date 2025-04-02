import { CHECKIN_INSIGHTS_SERVICE_TOKEN } from '@/core/domain/checkins/contracts/checkinInsights.service.contract';
import { CheckinInsightsService } from '@/core/infrastructure/adapters/services/checkinInsights/checkinInsights.service';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { Module, forwardRef } from '@nestjs/common';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { TeamsModule } from './team.module';
import { MetricsModule } from './metrics.module';
import { ParametersModule } from './parameters.module';

@Module({
    imports: [
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => TeamsModule),
        forwardRef(() => MetricsModule),
        forwardRef(() => ParametersModule)
    ],
    providers: [
        PromptService,
        {
            provide: CHECKIN_INSIGHTS_SERVICE_TOKEN,
            useClass: CheckinInsightsService,
        },
    ],
    exports: [CHECKIN_INSIGHTS_SERVICE_TOKEN],
})
export class CheckinInsightsModule { }
