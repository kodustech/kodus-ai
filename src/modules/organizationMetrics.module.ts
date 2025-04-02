import { UseCases } from '@/core/application/use-cases/organizationMetrics';
import { ORGANIZATION_METRICS_REPOSITORY_TOKEN } from '@/core/domain/organizationMetrics/contracts/organizationMetrics.repository.contract';
import { ORGANIZATION_METRICS_SERVICE_TOKEN } from '@/core/domain/organizationMetrics/contracts/organizationMetrics.service.contract';
import { OrganizationMetricsDatabaseRepository } from '@/core/infrastructure/adapters/repositories/typeorm/organizationMetrics.repository';
import { OrganizationMetricsModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/organizationMetrics.model';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LogModule } from './log.module';
import { TeamsModule } from './team.module';
import { OrganizationMetricsController } from '@/core/infrastructure/http/controllers/organizationMetrics.controller';
import { MetricsModule } from './metrics.module';
import { GlobalCacheModule } from './cache.module';
import { SaveAllOrganizationMetricsHistoryUseCase } from '@/core/application/use-cases/organizationMetrics/save-metrics-history.use-case';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { OrganizationMetricsService } from '@/core/infrastructure/adapters/services/organizationMetrics.service';

@Module({
    imports: [
        TypeOrmModule.forFeature([OrganizationMetricsModel]),
        forwardRef(() => TeamsModule),
        forwardRef(() => MetricsModule),
        forwardRef(() => LogModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => PlatformIntegrationModule),
        GlobalCacheModule,
    ],
    providers: [
        ...UseCases,
        ProjectManagementService,
        CodeManagementService,
        SaveAllOrganizationMetricsHistoryUseCase,
        {
            provide: ORGANIZATION_METRICS_REPOSITORY_TOKEN,
            useClass: OrganizationMetricsDatabaseRepository,
        },
        {
            provide: ORGANIZATION_METRICS_SERVICE_TOKEN,
            useClass: OrganizationMetricsService,
        },
    ],
    controllers: [OrganizationMetricsController],
    exports: [
        ORGANIZATION_METRICS_REPOSITORY_TOKEN,
        ORGANIZATION_METRICS_SERVICE_TOKEN,
        SaveAllOrganizationMetricsHistoryUseCase,
    ],
})
export class OrganizationMetricsModule {}
