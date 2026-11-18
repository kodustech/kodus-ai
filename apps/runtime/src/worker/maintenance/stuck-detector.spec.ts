import { AggregationTemporality, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';

import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { StuckDetector, type StuckSource } from './stuck-detector';

class TestReader extends MetricReader {
    constructor() {
        super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
    }
    protected async onForceFlush() {}
    protected async onShutdown() {}
}

const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const MIN = 60_000;

function source(over: Partial<StuckSource> = {}): StuckSource {
    return {
        runs: async () => [{ runId: 'run-1', organizationId: 'org-1', state: 'queued', requestedAt: new Date(T0).toISOString() }],
        setups: async () => [],
        claims: async () => [],
        admissions: async () => [{ organizationId: 'org-1', kind: 'setup', key: 'k1', state: 'waiting', deadlineAt: new Date(T0 + 30 * MIN).toISOString(), createdAt: new Date(T0).toISOString() }],
        cells: async () => [],
        workflows: async () => [],
        claimCounts: async () => [{ state: 'bound', consumer: 'runtime', count: 3 }],
        ...over,
    };
}

async function harness(src: StuckSource, clock = { t: T0 }) {
    const reader = new TestReader();
    const metrics = new RuntimeMetrics(new MeterProvider({ readers: [reader] }).getMeter('test'));
    const events: Array<Record<string, unknown>> = [];
    const detector = new StuckDetector(src, metrics, { warn: (f) => void events.push(f) }, () => clock.t);
    const points = async (name: string) => {
        const { resourceMetrics } = await reader.collect();
        return (resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name)?.dataPoints ?? []).map((d) => ({ labels: d.attributes, value: d.value }));
    };
    return { detector, events, points };
}

describe('StuckDetector', () => {
    it('reports an item once when it crosses its bound: a runtime.stuck event with ids, state, age and bound, and the metrics', async () => {
        const { detector, events, points } = await harness(source());
        await detector.pass(new Date(T0 + 10 * MIN));
        expect(events).toEqual([]);
        await detector.pass(new Date(T0 + 60 * MIN));
        await detector.pass(new Date(T0 + 61 * MIN));
        expect(events.filter((e) => e['kodus.runtime.stuck.subject'] === 'run')).toEqual([
            expect.objectContaining({ msg: 'runtime.stuck', 'kodus.runtime.stuck.state': 'queued', 'kodus.runtime.run.id': 'run-1', 'kodus.organization.id': 'org-1', 'kodus.runtime.stuck.bound_ms': 35 * MIN }),
        ]);
        expect(await points('runtime.stuck.detected')).toEqual(expect.arrayContaining([{ labels: { 'kodus.runtime.stuck.subject': 'run' }, value: 1 }]));
        expect(await points('runtime.stuck.items')).toEqual(expect.arrayContaining([{ labels: { 'kodus.runtime.stuck.subject': 'run', 'kodus.runtime.stuck.state': 'queued' }, value: 1 }]));
        expect(await points('runtime.claims.open')).toEqual([{ labels: { 'kodus.runtime.claim.state': 'bound', 'kodus.runtime.claim.consumer': 'runtime' }, value: 3 }]);
        expect(await points('runtime.admission.queue_depth')).toEqual([{ labels: { kind: 'setup', state: 'waiting' }, value: 1 }]);
        expect(await points('runtime.admission.oldest_wait')).toEqual([{ labels: { kind: 'setup' }, value: 61 * MIN }]);
    });

    it('reports an item again when it comes back after leaving its state', async () => {
        let runs = [{ runId: 'run-1', organizationId: 'org-1', state: 'queued', requestedAt: new Date(T0).toISOString() }];
        const { detector, events } = await harness(source({ runs: async () => runs }));
        await detector.pass(new Date(T0 + 60 * MIN));
        runs = [];
        await detector.pass(new Date(T0 + 61 * MIN));
        runs = [{ runId: 'run-1', organizationId: 'org-1', state: 'queued', requestedAt: new Date(T0).toISOString() }];
        await detector.pass(new Date(T0 + 62 * MIN));
        expect(events.filter((e) => e['kodus.runtime.stuck.subject'] === 'run')).toHaveLength(2);
    });

    it('says which source it could not read and keeps the others, never reporting an unread source as empty', async () => {
        const { detector, points } = await harness(source({ claimCounts: async () => Promise.reject(new Error('db down')) }));
        await detector.pass(new Date(T0 + 1 * MIN));
        const pass = await detector.pass(new Date(T0 + 60 * MIN));
        expect(pass.unread).toEqual(['claim_counts']);
        expect(pass.items.map((i) => i.subject)).toEqual(expect.arrayContaining(['run', 'admission']));
        expect(await points('runtime.claims.open')).toEqual([]);
    });

    it('reports 0 once it no longer runs the passes (another replica holds the maintenance lock), so the max over replicas is the live one', async () => {
        const clock = { t: T0 + 60 * MIN };
        const { detector, points } = await harness(source(), clock);
        await detector.pass(new Date(clock.t));
        expect((await points('runtime.stuck.items')).map((p) => p.value)).toEqual([1, 1]);
        clock.t += 3 * MIN;
        expect((await points('runtime.stuck.items')).map((p) => p.value)).toEqual([0, 0]);
        expect((await points('runtime.claims.open')).map((p) => p.value)).toEqual([0]);
    });
});
