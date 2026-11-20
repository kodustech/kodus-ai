import { Inject, Injectable } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { ErrorRateResult } from '@libs/core/metrics/domain/metrics.types';
import {
    IMetricsRepository,
    METRICS_REPOSITORY_TOKEN,
} from '@libs/core/metrics/domain/contracts/metrics.repository.contract';

import { metricsWindow } from './metrics-window';

@Injectable()
export class GetErrorRatesUseCase implements IUseCase {
    constructor(
        @Inject(METRICS_REPOSITORY_TOKEN)
        private readonly metricsRepository: IMetricsRepository,
    ) {}

    /** Error rate per component over the last `windowMinutes` (1 to 1440, default 15). */
    async execute(input: {
        windowMinutes?: number;
    }): Promise<ErrorRateResult[]> {
        const windowMinutes = metricsWindow(input.windowMinutes, 15, 1440);
        const since = new Date(Date.now() - windowMinutes * 60 * 1000);

        const counts =
            await this.metricsRepository.sumHttpCountsByComponent(since);

        const byComponent = new Map<
            string,
            { errors: number; requests: number }
        >();
        for (const { component, name, count } of counts) {
            const entry = byComponent.get(component) ?? {
                errors: 0,
                requests: 0,
            };
            if (name === 'http_errors_total') entry.errors += count;
            else entry.requests += count;
            byComponent.set(component, entry);
        }

        return Array.from(byComponent.entries()).map(
            ([component, { errors, requests }]) => ({
                component,
                totalRequests: requests,
                totalErrors: errors,
                errorRate:
                    requests > 0
                        ? Math.round((errors / requests) * 10000) / 100
                        : 0,
                windowMinutes,
            }),
        );
    }
}
