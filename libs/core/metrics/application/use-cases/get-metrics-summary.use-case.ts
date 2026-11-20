import { Inject, Injectable } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { MetricsSummary } from '@libs/core/metrics/domain/metrics.types';
import {
    IMetricsRepository,
    METRICS_REPOSITORY_TOKEN,
} from '@libs/core/metrics/domain/contracts/metrics.repository.contract';

import { GetErrorRatesUseCase } from './get-error-rates.use-case';

@Injectable()
export class GetMetricsSummaryUseCase implements IUseCase {
    constructor(
        @Inject(METRICS_REPOSITORY_TOKEN)
        private readonly metricsRepository: IMetricsRepository,
        private readonly getErrorRatesUseCase: GetErrorRatesUseCase,
    ) {}

    /** Error rates of the last 15 minutes and the reviews of the last hour. */
    async execute(): Promise<MetricsSummary> {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

        const [errorRate, durations, failed] = await Promise.all([
            this.getErrorRatesUseCase.execute({ windowMinutes: 15 }),
            this.metricsRepository.findReviewDurations(oneHourAgo),
            this.metricsRepository.countReviewErrors(oneHourAgo),
        ]);

        return {
            errorRate,
            reviewsProcessed: durations.length,
            reviewsFailed: failed,
            avgReviewDurationMs:
                durations.length > 0
                    ? Math.round(
                          durations.reduce((s, v) => s + v, 0) /
                              durations.length,
                      )
                    : 0,
            timestamp: new Date().toISOString(),
        };
    }
}
