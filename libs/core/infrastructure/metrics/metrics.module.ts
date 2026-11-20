import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
    MetricsEventModel,
    MetricsEventSchema,
} from './schemas/metrics-event.schema';
import { MetricsCollectorService } from './metrics-collector.service';
import { MetricsRepository } from './metrics.repository';
import { METRICS_REPOSITORY_TOKEN } from '@libs/core/metrics/domain/contracts/metrics.repository.contract';
import { GetErrorRatesUseCase } from '@libs/core/metrics/application/use-cases/get-error-rates.use-case';
import { GetMetricsSummaryUseCase } from '@libs/core/metrics/application/use-cases/get-metrics-summary.use-case';
import { GetPipelinePerformanceUseCase } from '@libs/core/metrics/application/use-cases/get-pipeline-performance.use-case';
import { GetReviewResponseTimesUseCase } from '@libs/core/metrics/application/use-cases/get-review-response-times.use-case';

const METRICS_USE_CASES = [
    GetErrorRatesUseCase,
    GetReviewResponseTimesUseCase,
    GetPipelinePerformanceUseCase,
    GetMetricsSummaryUseCase,
];

@Global()
@Module({
    imports: [
        MongooseModule.forFeature([
            { name: MetricsEventModel.name, schema: MetricsEventSchema },
        ]),
    ],
    providers: [
        MetricsCollectorService,
        { provide: METRICS_REPOSITORY_TOKEN, useClass: MetricsRepository },
        ...METRICS_USE_CASES,
    ],
    exports: [MetricsCollectorService, MongooseModule, ...METRICS_USE_CASES],
})
export class MetricsModule {}
