import { metrics, type Meter } from '@opentelemetry/api';

import type {
    PublishMeasurement,
    PublishMetrics,
    RedriveMeasurement,
    RedriveMetrics,
} from '../domain/runtime-publish.ports';

export const PUBLISH_METRIC = {
    outcome: 'runtime.publish.outcome',
    duration: 'runtime.publish.duration',
    redrive: 'runtime.publish.redrive',
    stuck: 'runtime.publish.stuck',
} as const;

/**
 * Publish outcomes of the product worker (ADR-052). A `refused` other than
 * target_not_found is a bug or tampering on the Runtime side and is worth an
 * alert; `retry` counts deliveries the broker redelivers.
 */
export class OtelPublishMetrics implements PublishMetrics, RedriveMetrics {
    private readonly outcomes;
    private readonly duration;
    private readonly redrives;
    /** Last sweep's count, read by the gauge's callback; undefined until the first sweep. */
    private stuck: number | undefined;

    constructor(meter: Meter = metrics.getMeter('kody-runtime-publish')) {
        this.outcomes = meter.createCounter(PUBLISH_METRIC.outcome, {
            description: 'Runtime publish deliveries by kind, outcome and reason',
        });
        this.duration = meter.createHistogram(PUBLISH_METRIC.duration, {
            description: 'Time to handle one Runtime publish delivery',
            unit: 'ms',
        });
        this.redrives = meter.createCounter(PUBLISH_METRIC.redrive, {
            description: 'Final Runtime publications the product re-drove, by kind, step and outcome',
        });
        meter
            .createObservableGauge(PUBLISH_METRIC.stuck, {
                description: 'Final Runtime publications failed or abandoned past the redrive threshold, at the last sweep',
            })
            .addCallback((result) => {
                if (this.stuck !== undefined) result.observe(this.stuck);
            });
    }

    recordRedrive(m: RedriveMeasurement): void {
        this.redrives.add(1, { kind: m.kind, step: m.step, outcome: m.outcome });
    }

    recordStuck(count: number): void {
        this.stuck = Math.max(0, count);
    }

    record(m: PublishMeasurement): void {
        const attributes = {
            kind: m.kind,
            outcome: m.outcome,
            ...(m.reason ? { reason: m.reason } : {}),
        };
        this.outcomes.add(1, attributes);
        this.duration.record(Math.max(0, m.durationMs), attributes);
    }
}
