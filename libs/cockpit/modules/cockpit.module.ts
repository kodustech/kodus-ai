import { forwardRef, Module } from '@nestjs/common';

import { AnalyticsWarehouseModule } from '@libs/ee/analytics-warehouse';
import { EmailModule } from '@libs/common/email/email.module';
import { LicenseModule } from '@libs/ee/license/license.module';
import { UserModule } from '@libs/identity/modules/user.module';
import { OrganizationModule } from '@libs/organization/modules/organization.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';

import { COCKPIT_DEVELOPER_PRODUCTIVITY_SERVICE_TOKEN } from '../domain/contracts/cockpit-developer-productivity.service.contract';
import { COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN } from '../domain/contracts/cockpit-review-analytics.service.contract';
import { GetKodyRulesHealthUseCase } from '../application/use-cases/get-kody-rules-health.use-case';
import { SendWeeklyRecapUseCase } from '../application/use-cases/send-weekly-recap.use-case';
import { KodyRulesModule } from '@libs/kodyRules/modules/kodyRules.module';
import { CockpitTierGuard } from '../infrastructure/guards/cockpit-tier.guard';
import { CockpitCodeHealthService } from '../infrastructure/services/cockpit-code-health.service';
import { CockpitDeveloperProductivityService } from '../infrastructure/services/cockpit-developer-productivity.service';
import { CockpitHealthService } from '../infrastructure/services/cockpit-health.service';
import { CockpitReviewAnalyticsService } from '../infrastructure/services/cockpit-review-analytics.service';
import { CockpitSourceResolver } from '../infrastructure/services/cockpit-source.resolver';
import { CockpitValidationService } from '../infrastructure/services/cockpit-validation.service';
import { NotificationModule } from '@libs/notifications/modules/notification.module';

/**
 * Entry point for the in-process cockpit — replaces the external
 * `kodus-service-analytics` deployment on both cloud and self-hosted.
 * Queries go against `analytics.*` tables that the worker ingestion
 * pipeline keeps in sync with Mongo.
 */
@Module({
    imports: [
        AnalyticsWarehouseModule.forRoot(),
        LicenseModule,
        EmailModule,
        forwardRef(() => UserModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => NotificationModule),
        forwardRef(() => KodyRulesModule),
        forwardRef(() => TeamModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => IntegrationConfigModule),
    ],
    providers: [
        CockpitSourceResolver,
        CockpitHealthService,
        CockpitValidationService,
        CockpitCodeHealthService,
        CockpitReviewAnalyticsService,
        CockpitDeveloperProductivityService,
        {
            provide: COCKPIT_DEVELOPER_PRODUCTIVITY_SERVICE_TOKEN,
            useExisting: CockpitDeveloperProductivityService,
        },
        {
            provide: COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN,
            useExisting: CockpitReviewAnalyticsService,
        },
        CockpitTierGuard,
        GetKodyRulesHealthUseCase,
        SendWeeklyRecapUseCase,
    ],
    exports: [
        CockpitSourceResolver,
        CockpitHealthService,
        CockpitValidationService,
        CockpitCodeHealthService,
        CockpitReviewAnalyticsService,
        CockpitDeveloperProductivityService,
        COCKPIT_DEVELOPER_PRODUCTIVITY_SERVICE_TOKEN,
        COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN,
        CockpitTierGuard,
        GetKodyRulesHealthUseCase,
        SendWeeklyRecapUseCase,
    ],
})
export class CockpitModule {}
