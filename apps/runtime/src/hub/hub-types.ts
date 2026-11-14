import { Meter, metrics } from '@opentelemetry/api';

import type { Envelope, MessageBody } from '@libs/runtime/protocol';

// Types shared by the hub's parts (connections, enrollment, claims, steps).

export interface SocketLike {
    /** ws reports bytes queued locally; absent only on in-memory test transports. */
    readonly bufferedAmount?: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    /** Stop retaining queued bytes immediately when a peer stops reading. */
    terminate?(): void;
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

export type IssuedIdentity = { ok: true; cellId: string; certificate: string; caCertificate: string; expiresAt: string; serial: string };

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
export const BOOT_PHASES = { prepareMs: 'prepare', bootMs: 'boot', buildMs: 'build', upMs: 'up', seedMs: 'seed', readyMs: 'ready', snapshotMs: 'snapshot' } as const;
export type BootPhase = (typeof BOOT_PHASES)[keyof typeof BOOT_PHASES];

/**
 * The cell drivers the hub names in its metrics. A cell reports its driver
 * itself (hello.driver, any string up to 64 characters): a customer cell
 * must not be able to grow a series per name, so anything else is 'other'.
 */
export const METRIC_DRIVERS = ['local-docker', 'docker-gvisor', 'aws-ec2', 'k8s-sandbox', 'fake'] as const;
export const driverLabel = (driver: string | undefined): string => ((METRIC_DRIVERS as readonly string[]).includes(driver ?? '') ? driver! : 'other');

/** How a claim.renew ended, as the `outcome` label: renewed, renewed up to the hard ceiling, the claim is gone, or the cell did not move the lease. */
export type RenewOutcome = 'renewed' | 'ceiling' | 'gone' | 'failed';

/** Hub metrics beyond the §11 set (libs/runtime/telemetry); every label is a closed set, never an org, environment or claim id. */
export class HubMetrics {
    private readonly readyWait;
    private readonly bootPhase;
    private readonly stepDuration;
    private readonly background;
    private readonly reconciled;
    private readonly transitions;
    private readonly renewals;
    private readonly capacityWaits;
    private readonly connectionOverloads;

    constructor(meter: Meter = metrics.getMeter('kody-runtime-hub')) {
        this.readyWait = meter.createHistogram('runtime.claim.ready_wait', { unit: 'ms', description: 'claim.acquire to claim.ready/failed/lost' });
        this.bootPhase = meter.createHistogram('runtime.claim.boot_phase', {
            unit: 'ms',
            description: 'Each boot phase the cell measured for a claim that became ready (claim.ready.timing)',
        });
        this.stepDuration = meter.createHistogram('runtime.step.duration', { unit: 'ms', description: 'step sent to step.result' });
        this.background = meter.createCounter('runtime.hub.background_error', { description: 'Failures of background work (pins, revocation, stream, session)' });
        this.reconciled = meter.createCounter('runtime.claim.reconciled', { description: 'Claims a cell held that the hub had finished: released on heartbeat' });
        this.transitions = meter.createCounter('runtime.claim.transition', { description: 'Claim state changes, by state reached and ClaimReason' });
        this.renewals = meter.createCounter('runtime.claim.renew', { description: 'claim.renew sent for a live claim, by how it ended' });
        this.capacityWaits = meter.createCounter('runtime.claim.capacity_wait', { description: 'claim.acquire rounds refused for memory before anything started (ADR-070): the worker waits and asks again' });
        this.connectionOverloads = meter.createCounter('runtime.hub.connection_overload', { description: 'Cell connections closed at an outgoing byte or in-flight work ceiling' });
    }

    claimReadyWait(ms: number, attrs: { outcome: string; consumer: string; driver?: string }) {
        this.readyWait.record(Math.max(0, ms), { outcome: attrs.outcome, consumer: attrs.consumer, driver: driverLabel(attrs.driver) });
    }
    /**
     * One point per phase the cell reported. A phase it did not measure
     * (absent) is not recorded as 0: a pool claim has no build to count.
     */
    claimBootPhases(timing: Partial<Record<keyof typeof BOOT_PHASES, number>> | undefined, attrs: { consumer: string; driver?: string }) {
        if (!timing) return;
        const driver = driverLabel(attrs.driver);
        for (const [field, phase] of Object.entries(BOOT_PHASES) as Array<[keyof typeof BOOT_PHASES, BootPhase]>) {
            const ms = timing[field];
            if (typeof ms === 'number' && Number.isFinite(ms)) this.bootPhase.record(Math.max(0, ms), { phase, consumer: attrs.consumer, driver });
        }
    }
    step(ms: number, attrs: { kind: string; outcome: string }) {
        this.stepDuration.record(Math.max(0, ms), attrs);
    }
    backgroundError(op: string) {
        this.background.add(1, { op });
    }
    claimReconciled() {
        this.reconciled.add(1);
    }
    /** Both labels are closed sets: ClaimState and ClaimReason. */
    claimTransition(attrs: { to: string; reason: string }) {
        this.transitions.add(1, attrs);
    }
    claimRenew(attrs: { outcome: RenewOutcome; consumer: string }) {
        this.renewals.add(1, attrs);
    }
    claimCapacityWait(attrs: { consumer: string }) {
        this.capacityWaits.add(1, attrs);
    }
    connectionOverload(reason: 'buffer' | 'frame' | 'requests' | 'steps') {
        this.connectionOverloads.add(1, { reason });
    }
}
