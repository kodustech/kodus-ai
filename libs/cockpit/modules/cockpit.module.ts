import { forwardRef, Module } from '@nestjs/common';

import { AnalyticsWarehouseModule } from '@libs/ee/analytics-warehouse';
import { EmailModule } from '@libs/common/email/email.module';
import { LicenseModule } from '@libs/ee/license/license.module';
import { UserModule } from '@libs/identity/modules/user.module';
import { OrganizationModule } from '@libs/organization/modules/organization.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';

import { COCKPIT_CODE_HEALTH_SERVICE_TOKEN } from '../domain/contracts/cockpit-code-health.service.contract';
import { COCKPIT_DEVELOPER_PRODUCTIVITY_SERVICE_TOKEN } from '../domain/contracts/cockpit-developer-productivity.service.contract';
import { COCKPIT_REPORTS_SERVICE_TOKEN } from '../domain/contracts/cockpit-reports.service.contract';
import { COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN } from '../domain/contracts/cockpit-review-analytics.service.contract';
import { REPORT_RECIPIENTS_SERVICE_TOKEN } from '../domain/contracts/report-recipients.service.contract';
import { GetKodyRulesHealthUseCase } from '../application/use-cases/get-kody-rules-health.use-case';
import { SendOrgReportUseCase } from '../application/use-cases/send-org-report.use-case';
import { SendRepoReportUseCase } from '../application/use-cases/send-repo-report.use-case';
import { ReportRecipientsService } from '../application/services/report-recipients.service';
import { KodyRulesModule } from '@libs/kodyRules/modules/kodyRules.module';
import { CockpitTierGuard } from '../infrastructure/guards/cockpit-tier.guard';
import { CockpitCodeHealthService } from '../infrastructure/services/cockpit-code-health.service';
import { CockpitDeveloperProductivityService } from '../infrastructure/services/cockpit-developer-productivity.service';
import { CockpitHealthService } from '../infrastructure/services/cockpit-health.service';
import { CockpitReportsService } from '../infrastructure/services/cockpit-reports.service';
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
        // forFeature (not forRoot): ApiModule already calls forRoot() and owns
        // the single analytics DataSource registration. A second forRoot() here
        // throws DuplicateDataSourceException under @nestjs/typeorm.
        AnalyticsWarehouseModule.forFeature(),
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
        {
            provide: COCKPIT_CODE_HEALTH_SERVICE_TOKEN,
            useExisting: CockpitCodeHealthService,
        },
        CockpitTierGuard,
        GetKodyRulesHealthUseCase,
        CockpitReportsService,
        ReportRecipientsService,
        {
            provide: COCKPIT_REPORTS_SERVICE_TOKEN,
            useExisting: CockpitReportsService,
        },
        {
            provide: REPORT_RECIPIENTS_SERVICE_TOKEN,
            useExisting: ReportRecipientsService,
        },
        SendOrgReportUseCase,
        SendRepoReportUseCase,
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
        COCKPIT_CODE_HEALTH_SERVICE_TOKEN,
        CockpitTierGuard,
        GetKodyRulesHealthUseCase,
        SendOrgReportUseCase,
        SendRepoReportUseCase,
    ],
})
export class CockpitModule {}
