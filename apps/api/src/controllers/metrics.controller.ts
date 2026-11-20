import { Controller, Get, Query } from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';

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
import { GetErrorRatesUseCase } from '@libs/core/metrics/application/use-cases/get-error-rates.use-case';
import { GetMetricsSummaryUseCase } from '@libs/core/metrics/application/use-cases/get-metrics-summary.use-case';
import { GetPipelinePerformanceUseCase } from '@libs/core/metrics/application/use-cases/get-pipeline-performance.use-case';
import { GetReviewResponseTimesUseCase } from '@libs/core/metrics/application/use-cases/get-review-response-times.use-case';

const toNumber = (value?: string) =>
    value === undefined ? undefined : parseInt(value, 10);

@ApiTags('Internal Metrics')
@ApiBearerAuth('jwt')
@Controller('internal/metrics')
export class MetricsController {
    constructor(
        private readonly getErrorRatesUseCase: GetErrorRatesUseCase,
        private readonly getReviewResponseTimesUseCase: GetReviewResponseTimesUseCase,
        private readonly getPipelinePerformanceUseCase: GetPipelinePerformanceUseCase,
        private readonly getMetricsSummaryUseCase: GetMetricsSummaryUseCase,
    ) {}

    @Get('error-rates')
    @ApiOperation({
        summary: 'Error rate by component',
        description:
            'Internal endpoint (requires JWT). Returns aggregated error rates by component for the requested window. Do not expose publicly.',
    })
    @ApiQuery({
        name: 'window',
        required: false,
        description: 'Window in minutes (1 to 1440). Default: 15',
        type: Number,
        example: 15,
    })
    @ApiOkResponse({ type: MetricsErrorRateResponseDto })
    getErrorRates(
        @Query('window') windowParam?: string,
    ): Promise<ErrorRateResult[]> {
        return this.getErrorRatesUseCase.execute({
            windowMinutes: toNumber(windowParam),
        });
    }

    @Get('review-response-times')
    @ApiOperation({
        summary: 'Review response times',
        description:
            'Internal endpoint (requires JWT). Response time statistics for reviews in hours. Do not expose publicly.',
    })
    @ApiQuery({
        name: 'hours',
        required: false,
        description: 'Window in hours (1 to 168). Default: 24',
        type: Number,
        example: 24,
    })
    @ApiOkResponse({ type: MetricsResponseTimeResponseDto })
    getReviewResponseTimes(
        @Query('hours') hoursParam?: string,
    ): Promise<ResponseTimeResult> {
        return this.getReviewResponseTimesUseCase.execute({
            hours: toNumber(hoursParam),
        });
    }

    @Get('pipeline-performance')
    @ApiOperation({
        summary: 'Pipeline performance',
        description:
            'Internal endpoint (requires JWT). Aggregates average duration by pipeline and stage. Do not expose publicly.',
    })
    @ApiQuery({
        name: 'hours',
        required: false,
        description: 'Window in hours (1 to 168). Default: 24',
        type: Number,
        example: 24,
    })
    @ApiOkResponse({ type: MetricsPipelinePerformanceResponseDto })
    getPipelinePerformance(
        @Query('hours') hoursParam?: string,
    ): Promise<PipelinePerformanceResult[]> {
        return this.getPipelinePerformanceUseCase.execute({
            hours: toNumber(hoursParam),
        });
    }

    @Get('summary')
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
