import { METRICS_FACTORY_TOKEN } from '@/core/domain/metrics/contracts/metrics.factory.contract';
import { METRICS_REPOSITORY_TOKEN } from '@/core/domain/metrics/contracts/metrics.repository.contract';
import { METRICS_SERVICE_TOKEN } from '@/core/domain/metrics/contracts/metrics.service.contract';
import { MetricsDatabaseRepository } from '@/core/infrastructure/adapters/repositories/typeorm/metrics.repository';
import { MetricsModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/metrics.model';
import { MetricsFactory } from '@/core/infrastructure/adapters/services/metrics/processMetrics/metrics.factory';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JiraModule } from './jira.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { UseCases } from '@/core/application/use-cases/metrics';
import { MetricsController } from '@/core/infrastructure/http/controllers/metrics.controller';
import { TeamsModule } from './team.module';
import { LogModule } from './log.module';
import { MetricsService } from '@/core/infrastructure/adapters/services/metrics/metrics.service';
import { IntegrationModule } from '@/modules/integration.module';
import { SaveFlowMetricsToDbUseCase } from '@/core/application/use-cases/metrics/save-db-flow-metrics.use-case';
import { GetMetricsByTeamUseCase } from '@/core/application/use-cases/metrics/get-metrics-by-team.use-case';
import { GetMetricsByOrganizationUseCase } from '@/core/application/use-cases/metrics/get-metrics-by-organization.use-case';
import { DoraMetricsFactory } from '@/core/infrastructure/adapters/services/metrics/processMetrics/doraMetrics/doraMetrics.factory';
import { DORA_METRICS_FACTORY_TOKEN } from '@/core/domain/metrics/contracts/doraMetrics.factory.contract';
import { SaveDoraMetricsToDbUseCase } from '@/core/application/use-cases/metrics/save-db-dora-metrics.use-case';
import { OrganizationParametersModule } from './organizationParameters.module';
import { GlobalCacheModule } from './cache.module';
import { GetEffortTeamUseCase } from '@/core/application/use-cases/platformIntegration/projectManagement/get-team-effort.use-case';
import { SaveAllTeamMetricsHistoryUseCase } from '@/core/application/use-cases/metrics/save-all-metrics-history.use-case';

@Module({
    imports: [
        TypeOrmModule.forFeature([MetricsModel]),
        forwardRef(() => JiraModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => TeamsModule),
        forwardRef(() => LogModule),
        OrganizationParametersModule,
        GlobalCacheModule,
    ],
    providers: [
        ...UseCases,
        GetEffortTeamUseCase,
        SaveAllTeamMetricsHistoryUseCase,
        {
            provide: METRICS_REPOSITORY_TOKEN,
            useClass: MetricsDatabaseRepository,
        },
        {
            provide: METRICS_SERVICE_TOKEN,
            useClass: MetricsService,
        },
        {
            provide: METRICS_FACTORY_TOKEN,
            useClass: MetricsFactory,
        },
        {
            provide: DORA_METRICS_FACTORY_TOKEN,
            useClass: DoraMetricsFactory,
        },
    ],
    controllers: [MetricsController],
    exports: [
        METRICS_REPOSITORY_TOKEN,
        METRICS_SERVICE_TOKEN,
        METRICS_FACTORY_TOKEN,
        DORA_METRICS_FACTORY_TOKEN,
        SaveFlowMetricsToDbUseCase,
        SaveDoraMetricsToDbUseCase,
        GetMetricsByTeamUseCase,
        GetMetricsByOrganizationUseCase,
        GetEffortTeamUseCase,
        SaveAllTeamMetricsHistoryUseCase,
    ],
})
export class MetricsModule { }
