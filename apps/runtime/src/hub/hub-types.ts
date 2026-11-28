import { Meter, metrics } from '@opentelemetry/api';

import { ATTR, CatalogMeter, dimension, exportStepsOf, METRIC_DRIVERS } from '@libs/runtime/telemetry';

import type { Envelope, MessageBody } from '@libs/runtime/protocol';

// Types shared by the hub's parts (connections, enrollment, claims, steps).

export interface SocketLike {
    /** ws reports bytes queued locally; absent only on in-memory test transports. */
    readonly bufferedAmount?: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    /** Stop retaining queued bytes immediately when a peer stops reading. */
    terminate?(): void;
    /** Stop reading the peer (TCP pushes back on it) while its frames wait to be handled; ws only. */
    pause?(): void;
    resume?(): void;
}

export interface CellCredential {
    cellId: string;
    owner: 'kodus' | 'customer';
    orgId?: string;
}

/** What the TLS layer saw: the verified peer certificate of the connection. */
export interface PeerCert {
    authorized: boolean;
    cn?: string;
    role?: string;
    serial?: string;
}

/** One structured hub log line. Ids only: never a repo token, a certificate or a key. */
export interface HubLogLine {
    level: 'info' | 'warn' | 'error';
    msg: string;
    replicaId: string;
    cellId?: string;
    claimId?: string;
    runId?: string;
    stepId?: string;
    [field: string]: unknown;
}

export type HubLog = (level: HubLogLine['level'], msg: string, fields?: Omit<HubLogLine, 'level' | 'msg' | 'replicaId'>) => void;

export type IssuedIdentity = {
    ok: true;
    cellId: string;
    certificate: string;
    caCertificate: string;
    expiresAt: string;
    serial: string;
    /** A fleet host's token key (`run:<org>/<run>`, `template:<org>/<env>`, `setup:<org>/<hash>` or `suite:<org>/<suiteRun>/<shard>`): how the cell learns the org it serves. */
    boundKey?: string;
};

/** The claim a worker call names, and the tenant it says the claim belongs to (checked against the row). */
export interface ClaimRef {
    claimId: string;
    organizationId: string;
    /** When given (a Run's claim), it must be the claim's Run; a setup claim has none. */
    runId?: string | null;
}

export { CellUnavailableError } from '../shared/errors';

/** A worker named a claim of another org, Run or environment: refused, never acted on. */
export class ClaimScopeError extends Error {
    readonly code = 'unknown_claim';
}

export type ReadyOutcome =
    | { type: 'ready'; body: MessageBody<'claim.ready'> }
    | { type: 'failed'; body: MessageBody<'claim.failed'> }
    /**
     * No ready or failed frame came: the wait ran out (the boot is longer than
     * the ceiling), the cell disconnected, or a newer wait for the same claim
     * took its place.
     */
    | { type: 'lost'; why: 'timeout' | 'disconnected' | 'superseded' }
    | { type: 'released' };

export type StepOutcome = Envelope<'step.result'> | { type: 'lost' } | { type: 'compromised'; signature: string } | { type: 'refused'; code: string };

/** The boot phases of claim.ready.timing, as the metric's `phase` label (a closed set). */
/** The named boot phase a cell reports for pulling the PR's image from the store (the Go cell's PhasePullPRImage). */
export const PHASE_PULL_PR_IMAGE = 'pull pr image';

export const BOOT_PHASES = { prepareMs: 'prepare', bootMs: 'boot', buildMs: 'build', upMs: 'up', seedMs: 'seed', readyMs: 'ready', snapshotMs: 'snapshot' } as const;
export type BootPhase = (typeof BOOT_PHASES)[keyof typeof BOOT_PHASES];

/**
 * The cell drivers the hub names in its metrics. A cell reports its driver
 * itself (hello.driver, any string up to 64 characters): a customer cell
 * must not be able to grow a series per name, so anything else is 'other'.
 */
export { METRIC_DRIVERS };
export const driverLabel = (driver: string | undefined): string => dimension(ATTR.driver, driver);

/** How a claim.renew ended, as the `outcome` label: renewed, renewed up to the hard ceiling, the claim is gone, or the cell did not move the lease. */
export type RenewOutcome = 'renewed' | 'ceiling' | 'gone' | 'failed';

/** One connected cell as the hub's capacity gauges read it. */
export interface CellCapacityView {
    owner: string;
    isolation?: string;
    driver?: string;
    /** From the last heartbeat; absent before the first one. */
    freeSlots?: number;
    lastFrameAt: number;
}

/** Hub metrics beyond the §11 set (libs/runtime/telemetry); every label is a closed set, never an org, environment or claim id. */
export class HubMetrics {
    private readonly readyWait;
    private readonly bootPhase;
    private readonly exportDuration;
    private readonly claimStart;
    private readonly stepDuration;
    private readonly background;
    private readonly reconciled;
    private readonly transitions;
    private readonly renewals;
    private readonly storeGrants;
    private readonly buildLayers;
    private readonly buildTime;
    private readonly storePrImages;
    private readonly storeShards;
    private readonly storeShardTime;
    private readonly capacityWaits;
    private readonly connectionOverloads;
    private readonly gbMinutes;
    private readonly vcpuMinutes;
    private readonly meter: CatalogMeter;

    constructor(meter: Meter = metrics.getMeter('kody-runtime-hub')) {
        const m = (this.meter = new CatalogMeter(meter));
        this.readyWait = m.histogram('runtime.claim.ready_wait');
        this.bootPhase = m.histogram('runtime.claim.boot_phase');
        this.exportDuration = m.histogram('runtime.build.export_duration');
        this.claimStart = m.counter('runtime.claim.start');
        this.stepDuration = m.histogram('runtime.step.duration');
        this.background = m.counter('runtime.hub.background_error');
        this.reconciled = m.counter('runtime.claim.reconciled');
        this.transitions = m.counter('runtime.claim.transition');
        this.renewals = m.counter('runtime.claim.renew');
        this.storeGrants = m.counter('runtime.image_store.grant');
        this.buildLayers = m.counter('runtime.claim.build_layers');
        this.buildTime = m.histogram('runtime.claim.build_time');
        this.storePrImages = m.counter('runtime.image_store.pr_image');
        this.storeShards = m.counter('runtime.image_store.shard');
        this.storeShardTime = m.histogram('runtime.image_store.shard_time');
        this.capacityWaits = m.counter('runtime.claim.capacity_wait');
        this.connectionOverloads = m.counter('runtime.hub.connection_overload');
        this.gbMinutes = m.counter('runtime.machine.gb_minutes');
        this.vcpuMinutes = m.counter('runtime.machine.vcpu_minutes');
    }

    claimReadyWait(ms: number, attrs: { outcome: string; consumer: string; driver?: string }) {
        this.readyWait.record(ms, { outcome: attrs.outcome, [ATTR.claimConsumer]: attrs.consumer, [ATTR.driver]: attrs.driver });
    }
    /**
     * One point per phase the cell reported. A phase it did not measure
     * (absent) is not recorded as 0: a pool claim has no build to count.
     */
    claimBootPhases(timing: Partial<Record<keyof typeof BOOT_PHASES, number>> | undefined, attrs: { consumer: string; driver?: string }) {
        if (!timing) return;
        for (const [field, phase] of Object.entries(BOOT_PHASES) as Array<[keyof typeof BOOT_PHASES, BootPhase]>) {
            const ms = timing[field];
            if (typeof ms === 'number' && Number.isFinite(ms)) this.bootPhase.record(ms, { [ATTR.bootPhase]: phase, [ATTR.claimConsumer]: attrs.consumer, [ATTR.driver]: attrs.driver });
        }
    }
    /** The export parts of a ready claim's timing.phases (absent parts are not recorded as 0). */
    claimExport(phases: ReadonlyArray<{ name: string; ms: number; running?: true }> | undefined, attrs: { consumer: string; driver?: string }) {
        for (const [step, ms] of Object.entries(exportStepsOf(phases))) {
            this.exportDuration.record(ms, { [ATTR.exportStep]: step, [ATTR.claimConsumer]: attrs.consumer, [ATTR.driver]: attrs.driver });
        }
    }
    /**
     * What a ready claim's image builds cost and how much of them a cache answered (claim.ready timing.buildSteps and
     * buildMs), by side: the PR side's cold build shows as a low cached share and a long time. A claim that built nothing
     * records nothing (a pool claim, an image taken as it was).
     */
    claimBuild(steps: { steps: number; cached: number } | undefined, buildMs: number | undefined, attrs: { side: string; consumer: string }) {
        if (!steps || steps.steps <= 0) return;
        const cached = Math.min(Math.max(steps.cached, 0), steps.steps);
        const labels = { [ATTR.claimSide]: attrs.side, [ATTR.claimConsumer]: attrs.consumer };
        if (cached > 0) this.buildLayers.add(cached, { result: 'cached', ...labels });
        if (steps.steps - cached > 0) this.buildLayers.add(steps.steps - cached, { result: 'built', ...labels });
        if (typeof buildMs === 'number' && Number.isFinite(buildMs) && buildMs > 0) this.buildTime.record(buildMs, labels);
    }
    /** A claim that became ready, by how its workload came to be (absent: the cell did not say). */
    claimStarted(start: string | undefined, attrs: { consumer: string }) {
        if (start) this.claimStart.add(1, { [ATTR.claimStart]: start, [ATTR.claimConsumer]: attrs.consumer });
    }
    step(ms: number, attrs: { kind: string; outcome: string }) {
        this.stepDuration.record(ms, { [ATTR.stepKind]: attrs.kind, outcome: attrs.outcome });
    }
    backgroundError(op: string) {
        this.background.add(1, { op });
    }
    claimReconciled() {
        this.reconciled.add(1);
    }
    /** Both labels are closed sets: ClaimState and ClaimReason. */
    claimTransition(attrs: { to: string; reason: string }) {
        this.transitions.add(1, { [ATTR.claimState]: attrs.to, [ATTR.claimReason]: attrs.reason });
    }
    imageStoreGrant(outcome: string) {
        this.storeGrants.add(1, { outcome });
    }
    imageStorePrImage(outcome: string) {
        this.storePrImages.add(1, { outcome });
    }
    /**
     * A suite shard's PR image (claim.ready of a claim the store was offered to): what its boot spent pulling it from the store or
     * building it, from the cell's named phases. `offered`: the hub gave the shard the builder's digests.
     */
    imageStoreShard(a: { offered: boolean; phases: ReadonlyArray<{ name: string; ms: number }> | undefined; buildMs: number | undefined }) {
        const pull = a.phases?.find((p) => p.name === PHASE_PULL_PR_IMAGE);
        if (pull) this.storeShardTime.record(pull.ms, { kind: 'pull' });
        else if (typeof a.buildMs === 'number') this.storeShardTime.record(a.buildMs, { kind: 'build' });
        this.storeShards.add(1, { outcome: pull ? 'pulled' : a.offered ? 'built_after_ask' : 'built_no_image' });
    }
    claimRenew(attrs: { outcome: RenewOutcome; consumer: string }) {
        this.renewals.add(1, { outcome: attrs.outcome, [ATTR.claimConsumer]: attrs.consumer });
    }
    claimCapacityWait(attrs: { consumer: string }) {
        this.capacityWaits.add(1, { [ATTR.claimConsumer]: attrs.consumer });
    }
    connectionOverload(reason: 'buffer' | 'frame' | 'requests' | 'steps' | 'inbound') {
        this.connectionOverloads.add(1, { reason });
    }
    /** A claim that ended: its machine time as the usage report counts it (vCPU only when its size is known). */
    machineTime(usage: { gbMinutes: number; vcpuMinutes?: number }, attrs: { consumer?: string | null; owner: string; orgId: string }) {
        const labels = { [ATTR.claimConsumer]: attrs.consumer ?? undefined, [ATTR.cellOwner]: attrs.owner, [ATTR.organizationId]: attrs.orgId };
        if (usage.gbMinutes > 0) this.gbMinutes.add(usage.gbMinutes, labels);
        if (usage.vcpuMinutes && usage.vcpuMinutes > 0) this.vcpuMinutes.add(usage.vcpuMinutes, labels);
    }
    /**
     * The capacity gauges of the cells connected to this replica, read at
     * collection: sessions by isolation and driver, free slots, full cells, and
     * the age of the oldest last frame (a cell that is connected but silent).
     */
    observeCells(read: () => CellCapacityView[], now: () => number = Date.now) {
        const byOwner = <T>(cells: CellCapacityView[], f: (c: CellCapacityView[]) => T) =>
            [...new Set(cells.map((c) => c.owner))].map((owner) => ({ owner, value: f(cells.filter((c) => c.owner === owner)) }));
        this.meter.gauge('runtime.cell.sessions', () => {
            const groups = new Map<string, { labels: Record<string, unknown>; value: number }>();
            for (const c of read()) {
                const labels = { [ATTR.cellOwner]: c.owner, [ATTR.isolationLevel]: c.isolation, [ATTR.driver]: c.driver };
                const key = JSON.stringify(labels);
                groups.set(key, { labels, value: (groups.get(key)?.value ?? 0) + 1 });
            }
            return [...groups.values()];
        });
        this.meter.gauge('runtime.cell.free_slots', () => byOwner(read(), (cs) => cs.reduce((n, c) => n + (c.freeSlots ?? 0), 0)).map((g) => ({ value: g.value, labels: { [ATTR.cellOwner]: g.owner } })));
        this.meter.gauge('runtime.cell.full', () => byOwner(read(), (cs) => cs.filter((c) => c.freeSlots === 0).length).map((g) => ({ value: g.value, labels: { [ATTR.cellOwner]: g.owner } })));
        this.meter.gauge('runtime.cell.heartbeat_age', () =>
            byOwner(read(), (cs) => Math.max(0, ...cs.map((c) => now() - c.lastFrameAt))).map((g) => ({ value: g.value, labels: { [ATTR.cellOwner]: g.owner } })),
        );
    }
}
