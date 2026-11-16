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
        const byPhase = Object.fromEntries(metric.dataPoints.map((p) => [p.attributes['kodus.runtime.boot.phase'] as string, (p.value as { sum: number }).sum]));
        expect(byPhase).toEqual({ prepare: 9_000, boot: 8_000, build: 5_000, up: 3_000 });
        for (const p of metric.dataPoints)
            expect(p.attributes).toEqual({ 'kodus.runtime.boot.phase': p.attributes['kodus.runtime.boot.phase'], 'kodus.runtime.claim.consumer': 'setup', 'kodus.runtime.driver': 'docker-gvisor' });
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
        expect(phases.dataPoints[0].attributes).toEqual({ 'kodus.runtime.boot.phase': 'prepare', 'kodus.runtime.claim.consumer': 'runtime', 'kodus.runtime.driver': 'other' });
        const wait = (await collect('runtime.claim.ready_wait'))!;
        expect(wait.dataPoints[0].attributes).toEqual({ outcome: 'ready', 'kodus.runtime.claim.consumer': 'runtime', 'kodus.runtime.driver': 'other' });
        expect(driverLabel('local-docker')).toBe('local-docker');
        expect(driverLabel(undefined)).toBe('other');
    });

    it('counts claim.renew by outcome and consumer only', async () => {
        const { m, collect } = await harness();
        m.claimRenew({ outcome: 'renewed', consumer: 'runtime' });
        m.claimRenew({ outcome: 'ceiling', consumer: 'runtime' });
        const metric = (await collect('runtime.claim.renew'))!;
        expect(metric.dataPoints.map((p) => p.attributes).sort((a, b) => String(a.outcome).localeCompare(String(b.outcome)))).toEqual([
            { outcome: 'ceiling', 'kodus.runtime.claim.consumer': 'runtime' },
            { outcome: 'renewed', 'kodus.runtime.claim.consumer': 'runtime' },
        ]);
    });

    it('records the export steps and the start of a claim that became ready, by the cell’s own names', async () => {
        const { m, collect } = await harness();
        m.claimExport([{ name: 'RUN pnpm build', ms: 50 }, { name: 'export layers', ms: 34_000 }], { consumer: 'setup', driver: 'docker-gvisor' });
        m.claimStarted('pool', { consumer: 'runtime' });
        m.claimStarted(undefined, { consumer: 'runtime' });
        const exp = (await collect('runtime.build.export_duration'))!;
        expect(exp.dataPoints.map((p) => p.attributes['kodus.runtime.build.export_step'])).toEqual(['export_layers']);
        const start = (await collect('runtime.claim.start'))!;
        expect(start.dataPoints.map((p) => [p.attributes, p.value])).toEqual([[{ 'kodus.runtime.claim.start': 'pool', 'kodus.runtime.claim.consumer': 'runtime' }, 1]]);
    });

    it('counts machine time by consumer, owner and org, and no vCPU time when the size is unknown', async () => {
        const { m, collect } = await harness();
        m.machineTime({ gbMinutes: 2.5, vcpuMinutes: 10 }, { consumer: 'setup', owner: 'kodus', orgId: 'org-1' });
        m.machineTime({ gbMinutes: 1 }, { consumer: 'runtime', owner: 'customer', orgId: 'org-1' });
        const gb = (await collect('runtime.machine.gb_minutes'))!;
        expect(gb.dataPoints.map((p) => p.value).sort()).toEqual([1, 2.5]);
        const cpu = (await collect('runtime.machine.vcpu_minutes'))!;
        expect(cpu.dataPoints.map((p) => [p.attributes['kodus.runtime.claim.consumer'], p.value])).toEqual([['setup', 10]]);
    });

    it('reads the connected cells at collection: sessions, free slots, full cells and the oldest silence', async () => {
        const { m, collect } = await harness();
        const now = 100_000;
        m.observeCells(
            () => [
                { owner: 'kodus', isolation: 'sandboxed-container', driver: 'docker-gvisor', freeSlots: 0, lastFrameAt: now - 4_000 },
                { owner: 'kodus', isolation: 'sandboxed-container', driver: 'docker-gvisor', freeSlots: 3, lastFrameAt: now - 70_000 },
                { owner: 'customer', isolation: 'vm', driver: 'aws-ec2', lastFrameAt: now - 1_000 },
            ],
            () => now,
        );
        const value = async (name: string, owner: string) => (await collect(name))!.dataPoints.find((p) => p.attributes['kodus.runtime.cell.owner'] === owner)?.value;
        expect(await value('runtime.cell.free_slots', 'kodus')).toBe(3);
        expect(await value('runtime.cell.full', 'kodus')).toBe(1);
        expect(await value('runtime.cell.full', 'customer')).toBe(0);
        expect(await value('runtime.cell.heartbeat_age', 'kodus')).toBe(70_000);
        expect(await value('runtime.cell.sessions', 'customer')).toBe(1);
    });
});
