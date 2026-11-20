import { Inject, Injectable } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { ResponseTimeResult } from '@libs/core/metrics/domain/metrics.types';
import {
    IMetricsRepository,
    METRICS_REPOSITORY_TOKEN,
} from '@libs/core/metrics/domain/contracts/metrics.repository.contract';

import { metricsWindow } from './metrics-window';

/** The value at percentile `p` of ascending `sorted` (nearest rank). */
export function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}

@Injectable()
export class GetReviewResponseTimesUseCase implements IUseCase {
    constructor(
        @Inject(METRICS_REPOSITORY_TOKEN)
        private readonly metricsRepository: IMetricsRepository,
    ) {}

    /** Review duration statistics over the last `hours` (1 to 168, default 24). */
    async execute(input: { hours?: number }): Promise<ResponseTimeResult> {
        const hours = metricsWindow(input.hours, 24, 168);
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);

        const values = (
            await this.metricsRepository.findReviewDurations(since)
        ).sort((a, b) => a - b);

        if (values.length === 0) {
            return {
                p50: 0,
                p95: 0,
                avg: 0,
                max: 0,
                count: 0,
                windowHours: hours,
            };
        }

        const sum = values.reduce((s, v) => s + v, 0);
        return {
            p50: percentile(values, 50),
            p95: percentile(values, 95),
            avg: Math.round(sum / values.length),
            max: values[values.length - 1],
            count: values.length,
            windowHours: hours,
        };
    }
}
