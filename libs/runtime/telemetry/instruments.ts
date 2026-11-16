import type { Attributes, Meter, ObservableResult } from '@opentelemetry/api';

import { metricAttributes } from './telemetry-guard';
import { TAXONOMY, type Instrument } from './catalog';

// Instruments made from the metric catalog (taxonomy.json): a metric that is
// not in the catalog cannot be created, its unit and description come from
// the catalog, and every point's labels go through metricAttributes, so a
// label the catalog does not list, an id, or a value outside a dimension never
// becomes a series.

type Labels = Record<string, unknown>;

function specOf(name: string, instrument: Instrument) {
    const spec = TAXONOMY.metrics[name];
    if (!spec) throw new Error(`metric ${name} is not in the taxonomy`);
    if (spec.instrument !== instrument) throw new Error(`metric ${name} is a ${spec.instrument}, not a ${instrument}`);
    return spec;
}

export interface CatalogCounter {
    add(value: number, labels?: Labels): void;
}
export interface CatalogHistogram {
    record(value: number, labels?: Labels): void;
}

export class CatalogMeter {
    constructor(private readonly meter: Meter) {}

    counter(name: string): CatalogCounter {
        const spec = specOf(name, 'counter');
        const c = this.meter.createCounter(name, { unit: spec.unit, description: spec.meaning });
        return { add: (value, labels = {}) => c.add(Math.max(0, value), metricAttributes(name, labels)) };
    }

    updown(name: string): CatalogCounter {
        const spec = specOf(name, 'updowncounter');
        const c = this.meter.createUpDownCounter(name, { unit: spec.unit, description: spec.meaning });
        return { add: (value, labels = {}) => c.add(value, metricAttributes(name, labels)) };
    }

    histogram(name: string): CatalogHistogram {
        const spec = specOf(name, 'histogram');
        const h = this.meter.createHistogram(name, { unit: spec.unit, description: spec.meaning, ...(spec.buckets ? { advice: { explicitBucketBoundaries: spec.buckets } } : {}) });
        return { record: (value, labels = {}) => (Number.isFinite(value) ? h.record(Math.max(0, value), metricAttributes(name, labels)) : undefined) };
    }

    /** A gauge read at collection time; `read` returns its points (an empty list: no series). */
    gauge(name: string, read: () => Array<{ value: number; labels: Labels }>): void {
        const spec = specOf(name, 'gauge');
        const g = this.meter.createObservableGauge(name, { unit: spec.unit, description: spec.meaning });
        g.addCallback((result: ObservableResult<Attributes>) => {
            try {
                for (const p of read()) if (Number.isFinite(p.value)) result.observe(p.value, metricAttributes(name, p.labels));
            } catch {
                /* A gauge that cannot be read has no point this collection. */
            }
        });
    }
}
