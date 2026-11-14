import { AggregationTemporality, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';

import { driverLabel, HubMetrics } from './hub-types';

class TestReader extends MetricReader {
    constructor() {
        super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
    }
    protected async onForceFlush() {}
    protected async onShutdown() {}
}

async function harness() {
    const reader = new TestReader();
    const m = new HubMetrics(new MeterProvider({ readers: [reader] }).getMeter('test'));
    const collect = async (name: string) => {
        const { resourceMetrics } = await reader.collect();
        return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((x) => x.descriptor.name === name);
    };
    return { m, collect };
}

describe('HubMetrics', () => {
    it('records one boot_phase point per phase the cell measured, never an absent one as 0', async () => {
        const { m, collect } = await harness();
        m.claimBootPhases({ prepareMs: 9_000, bootMs: 8_000, buildMs: 5_000, upMs: 3_000 }, { consumer: 'setup', driver: 'docker-gvisor' });
        const metric = (await collect('runtime.claim.boot_phase'))!;
        const byPhase = Object.fromEntries(metric.dataPoints.map((p) => [p.attributes.phase as string, (p.value as { sum: number }).sum]));
        expect(byPhase).toEqual({ prepare: 9_000, boot: 8_000, build: 5_000, up: 3_000 });
        for (const p of metric.dataPoints) expect(p.attributes).toEqual({ phase: p.attributes.phase, consumer: 'setup', driver: 'docker-gvisor' });
    });

    it('records nothing for a claim.ready without timing', async () => {
        const { m, collect } = await harness();
        m.claimBootPhases(undefined, { consumer: 'runtime', driver: 'aws-ec2' });
        expect((await collect('runtime.claim.boot_phase'))?.dataPoints ?? []).toHaveLength(0);
    });

    it('keeps the driver a closed set: a name the cell made up is "other" (bounded cardinality)', async () => {
        const { m, collect } = await harness();
        for (const driver of ['evil-1', 'evil-2', 'evil-3']) m.claimBootPhases({ prepareMs: 1 }, { consumer: 'runtime', driver });
        m.claimReadyWait(10, { outcome: 'ready', consumer: 'runtime', driver: 'evil-4' });
        const phases = (await collect('runtime.claim.boot_phase'))!;
        expect(phases.dataPoints).toHaveLength(1);
        expect(phases.dataPoints[0].attributes).toEqual({ phase: 'prepare', consumer: 'runtime', driver: 'other' });
        const wait = (await collect('runtime.claim.ready_wait'))!;
        expect(wait.dataPoints[0].attributes).toEqual({ outcome: 'ready', consumer: 'runtime', driver: 'other' });
        expect(driverLabel('local-docker')).toBe('local-docker');
        expect(driverLabel(undefined)).toBe('other');
    });

    it('counts claim.renew by outcome and consumer only', async () => {
        const { m, collect } = await harness();
        m.claimRenew({ outcome: 'renewed', consumer: 'runtime' });
        m.claimRenew({ outcome: 'ceiling', consumer: 'runtime' });
        const metric = (await collect('runtime.claim.renew'))!;
        expect(metric.dataPoints.map((p) => p.attributes).sort((a, b) => String(a.outcome).localeCompare(String(b.outcome)))).toEqual([
            { outcome: 'ceiling', consumer: 'runtime' },
            { outcome: 'renewed', consumer: 'runtime' },
        ]);
    });
});
