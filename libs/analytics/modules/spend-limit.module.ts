import { Module, forwardRef } from '@nestjs/common';

import { OrganizationParametersModule } from '@libs/organization/modules/organizationParameters.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { NotificationEmitterModule } from '@libs/notifications/modules/notification-emitter.module';

import { ConfigureSpendLimitUseCase } from '../application/spend-limit/configure-spend-limit.use-case';
import { GetOrgByokModelsUseCase } from '../application/spend-limit/get-org-byok-models.use-case';
import { GetSpendLimitConfigUseCase } from '../application/spend-limit/get-spend-limit-config.use-case';
import { SpendLimitAlertService } from '../application/spend-limit/spend-limit-alert.service';
import { SpendLimitConfigService } from '../application/spend-limit/spend-limit-config.service';
import { AnalyticsModule } from './analytics.module';

/**
 * Composes the spend-limit feature: spend computation (AnalyticsModule),
 * org-parameter persistence (OrganizationParametersModule), and notification
 * emission (NotificationEmitterModule). The alert cron (Phase 4) and the
 * config endpoint (Phase 5) wire from here.
 */
@Module({
    imports: [
        AnalyticsModule,
        forwardRef(() => OrganizationParametersModule),
        ParametersModule,
        NotificationEmitterModule,
    ],
    providers: [
        SpendLimitConfigService,
        ConfigureSpendLimitUseCase,
        SpendLimitAlertService,
        GetOrgByokModelsUseCase,
        GetSpendLimitConfigUseCase,
    ],
    exports: [
        SpendLimitConfigService,
        ConfigureSpendLimitUseCase,
        SpendLimitAlertService,
        GetOrgByokModelsUseCase,
        GetSpendLimitConfigUseCase,
    ],
})
export class SpendLimitModule {}
