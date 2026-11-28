import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { AggregationTemporality, MetricReader } from '@opentelemetry/sdk-metrics';

import { CatalogMeter } from './instruments';
import { blockerSignatureClass, canonicalKey, OTHER, promLabel, promMetricName, TAXONOMY } from './catalog';

const ROOT = join(__dirname, '../../..');

class TestReader extends MetricReader {
    constructor() {
        super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
    }
    protected async onForceFlush() {}
    protected async onShutdown() {}
}

function files(dir: string, keep: (path: string) => boolean): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            if (!['node_modules', 'testing', '__tests__', 'fixtures', 'e2e', 'fake-cell', 'testdata'].includes(name)) out.push(...files(path, keep));
        } else if (keep(path)) out.push(path);
    }
    return out;
}

describe('the telemetry taxonomy', () => {
    it('labels every metric with taxonomy attributes or metric-local words; no id is a label, the tenant only on counters', () => {
        for (const [name, spec] of Object.entries(TAXONOMY.metrics)) {
            for (const label of spec.labels) {
                const attr = TAXONOMY.attributes[label];
                expect({ name, label, known: !!attr || label in TAXONOMY.metricLocalLabels }).toEqual({ name, label, known: true });
                if (!attr) continue;
                expect({ name, label, cardinality: attr.cardinality }).not.toEqual({ name, label, cardinality: 'id' });
                if (attr.cardinality === 'tenant') expect({ name, instrument: spec.instrument }).toEqual({ name, instrument: 'counter' });
            }
        }
    });

    it('gives every alias one attribute', () => {
        const seen = new Map<string, string>();
        for (const [key, spec] of Object.entries(TAXONOMY.attributes)) {
            for (const alias of spec.aliases ?? []) {
                expect({ alias, owner: seen.get(alias) ?? key }).toEqual({ alias, owner: key });
                seen.set(alias, key);
                expect(canonicalKey(alias)).toBe(key);
            }
        }
    });

    it('names each control-plane metric in Prometheus as promMetricName says, its labels as promLabel says', async () => {
        const reader = new TestReader();
        const meter = new CatalogMeter(new MeterProvider({ readers: [reader] }).getMeter('test'));
        const control = Object.entries(TAXONOMY.metrics).filter(([, s]) => !s.producer.split(',').some((p) => ['cell', 'injector', 'reaper', 'egress'].includes(p)));
        for (const [name, spec] of control) {
            const labels = Object.fromEntries(spec.labels.map((l) => [l, 'x']));
            if (spec.instrument === 'counter') meter.counter(name).add(1, labels);
            else if (spec.instrument === 'updowncounter') meter.updown(name).add(1, labels);
            else if (spec.instrument === 'histogram') meter.histogram(name).record(1, labels);
            else meter.gauge(name, () => [{ value: 1, labels }]);
        }
        const { resourceMetrics } = await reader.collect();
        const text = new PrometheusSerializer().serialize(resourceMetrics);
        for (const [name, spec] of control) {
            const series = spec.instrument === 'histogram' ? `${promMetricName(name)}_count` : promMetricName(name);
            expect({ name, present: new RegExp(`^${series}\\{`, 'm').test(text) || new RegExp(`^${series} `, 'm').test(text) }).toEqual({ name, present: true });
            for (const label of spec.labels) expect({ name, label, present: text.includes(`${promLabel(label)}="`) }).toEqual({ name, label, present: true });
        }
    });

    it('refuses a metric the catalog does not hold, and a label it does not list', () => {
        const meter = new CatalogMeter(new MeterProvider().getMeter('test'));
        expect(() => meter.counter('runtime.made.up')).toThrow(/not in the taxonomy/);
        expect(() => meter.histogram('runtime.run.state')).toThrow(/is a counter/);
    });

    it('classifies every blocker signature the code sets whole as itself, never "other" (drift guard)', () => {
        const ts = files(join(ROOT, 'apps/runtime/src'), (p) => p.endsWith('.ts') && !p.endsWith('.spec.ts'))
            .concat(files(join(ROOT, 'libs/runtime'), (p) => p.endsWith('.ts') && !p.endsWith('.spec.ts')))
            .flatMap((p) => [...readFileSync(p, 'utf8').matchAll(/signature: '([a-z_:]+)'/g)].map((m) => m[1]));
        const go = files(join(ROOT, 'apps/runtime-cell/internal'), (p) => p.endsWith('.go') && !p.endsWith('_test.go')).flatMap((p) =>
            [...readFileSync(p, 'utf8').matchAll(/blockerErr\([^,]+, "([a-z_]+)"[,)]/g)].map((m) => m[1]),
        );
        const signatures = [...new Set([...ts, ...go])];
        expect(signatures.length).toBeGreaterThan(40);
        expect(signatures.filter((s) => blockerSignatureClass(s) !== s)).toEqual([]);
    });

    it('cuts the repository text off a signature: an env name, a host, a service', () => {
        expect(blockerSignatureClass('missing_env:STRIPE_SECRET')).toBe('missing_env');
        expect(blockerSignatureClass('external_service:egress:api.vendor.example')).toBe('external_service:egress');
        expect(blockerSignatureClass('resources:memory:worker')).toBe('resources:memory');
        expect(blockerSignatureClass('setup:not_ready:web:3000/health')).toBe('setup:not_ready');
        expect(blockerSignatureClass('recipe_migrate')).toBe('recipe_migrate');
        expect(blockerSignatureClass('platform:mirror_artifact_missing:prisma')).toBe('platform:mirror_artifact_missing');
        expect(blockerSignatureClass('a host.example.com')).toBe(OTHER);
    });

    it('gives every histogram its own buckets, so a boot of minutes does not fall in one +Inf bucket', async () => {
        const histograms = Object.entries(TAXONOMY.metrics).filter(([, s]) => s.instrument === 'histogram' && !s.producer.startsWith('product'));
        expect(histograms.filter(([, s]) => !s.buckets?.length).map(([n]) => n)).toEqual([]);
        const reader = new TestReader();
        new CatalogMeter(new MeterProvider({ readers: [reader] }).getMeter('test')).histogram('runtime.claim.ready_wait').record(20 * 60_000, { outcome: 'ready' });
        const { resourceMetrics } = await reader.collect();
        const point = resourceMetrics.scopeMetrics[0].metrics[0].dataPoints[0].value as { buckets: { boundaries: number[] } };
        expect(point.buckets.boundaries).toEqual(TAXONOMY.metrics['runtime.claim.ready_wait'].buckets);
    });
});
