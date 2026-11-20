import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';

import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import {
    ErrorRateResult,
    MetricsSummary,
    PipelinePerformanceResult,
    ResponseTimeResult,
} from '@libs/core/metrics/domain/metrics.types';
import {
    MetricsErrorRateResponseDto,
    MetricsPipelinePerformanceResponseDto,
    MetricsResponseTimeResponseDto,
    MetricsSummaryResponseDto,
} from '@libs/core/infrastructure/metrics/metrics-response.dto';
import {
    MetricsHoursQueryDto,
    MetricsWindowQueryDto,
} from '../dtos/metrics-query.dto';
import { GetErrorRatesUseCase } from '@libs/core/metrics/application/use-cases/get-error-rates.use-case';
import { GetMetricsSummaryUseCase } from '@libs/core/metrics/application/use-cases/get-metrics-summary.use-case';
import { GetPipelinePerformanceUseCase } from '@libs/core/metrics/application/use-cases/get-pipeline-performance.use-case';
import { GetReviewResponseTimesUseCase } from '@libs/core/metrics/application/use-cases/get-review-response-times.use-case';

// Operational metrics of the platform: readable by whoever may read logs.
const canReadMetrics = checkPermissions({
    action: Action.Read,
    resource: ResourceType.Logs,
});

@ApiTags('Internal Metrics')
@ApiBearerAuth('jwt')
@UseGuards(PolicyGuard)
@Controller('internal/metrics')
export class MetricsController {
    constructor(
        private readonly getErrorRatesUseCase: GetErrorRatesUseCase,
        private readonly getReviewResponseTimesUseCase: GetReviewResponseTimesUseCase,
        private readonly getPipelinePerformanceUseCase: GetPipelinePerformanceUseCase,
        private readonly getMetricsSummaryUseCase: GetMetricsSummaryUseCase,
    ) {}

    @Get('error-rates')
    @CheckPolicies(canReadMetrics)
    @ApiOperation({
        summary: 'Error rate by component',
        description:
            'Internal endpoint (requires JWT). Returns aggregated error rates by component for the requested window. Do not expose publicly.',
    })
    @ApiOkResponse({ type: MetricsErrorRateResponseDto })
    getErrorRates(
        @Query() query: MetricsWindowQueryDto,
    ): Promise<ErrorRateResult[]> {
        return this.getErrorRatesUseCase.execute({
            windowMinutes: query.window,
        });
    }

    @Get('review-response-times')
    @CheckPolicies(canReadMetrics)
    @ApiOperation({
        summary: 'Review response times',
        description:
            'Internal endpoint (requires JWT). Response time statistics for reviews in hours. Do not expose publicly.',
    })
    @ApiOkResponse({ type: MetricsResponseTimeResponseDto })
    getReviewResponseTimes(
        @Query() query: MetricsHoursQueryDto,
    ): Promise<ResponseTimeResult> {
        return this.getReviewResponseTimesUseCase.execute({
            hours: query.hours,
        });
    }

    @Get('pipeline-performance')
    @CheckPolicies(canReadMetrics)
    @ApiOperation({
        summary: 'Pipeline performance',
        description:
            'Internal endpoint (requires JWT). Aggregates average duration by pipeline and stage. Do not expose publicly.',
    })
    @ApiOkResponse({ type: MetricsPipelinePerformanceResponseDto })
    getPipelinePerformance(
        @Query() query: MetricsHoursQueryDto,
    ): Promise<PipelinePerformanceResult[]> {
        return this.getPipelinePerformanceUseCase.execute({
            hours: query.hours,
        });
    }

    @Get('summary')
    @CheckPolicies(canReadMetrics)
    @ApiOperation({
        summary: 'Metrics summary',
        description:
            'Internal endpoint (requires JWT). Consolidated metrics snapshot. Do not expose publicly.',
    })
    @ApiOkResponse({ type: MetricsSummaryResponseDto })
    getSummary(): Promise<MetricsSummary> {
        return this.getMetricsSummaryUseCase.execute();
    }
}
