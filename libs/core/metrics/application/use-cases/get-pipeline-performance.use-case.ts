import { Inject, Injectable } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { PipelinePerformanceResult } from '@libs/core/metrics/domain/metrics.types';
import {
    IMetricsRepository,
    METRICS_REPOSITORY_TOKEN,
} from '@libs/core/metrics/domain/contracts/metrics.repository.contract';

import { metricsWindow } from './metrics-window';

@Injectable()
export class GetPipelinePerformanceUseCase implements IUseCase {
    constructor(
        @Inject(METRICS_REPOSITORY_TOKEN)
        private readonly metricsRepository: IMetricsRepository,
    ) {}

    /** Average stage duration per pipeline over the last `hours` (1 to 168, default 24). */
    async execute(input: {
        hours?: number;
    }): Promise<PipelinePerformanceResult[]> {
        const hours = metricsWindow(input.hours, 24, 168);
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);

        const rows = await this.metricsRepository.averageStageDurations(since);
        return rows.map((row) => ({
            pipeline: row.pipeline ?? 'unknown',
            stage: row.stage ?? 'unknown',
            avgDurationMs: Math.round(row.avgDurationMs),
            count: row.count,
        }));
    }
}
