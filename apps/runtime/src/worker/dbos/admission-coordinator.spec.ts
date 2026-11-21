import { randomUUID } from 'crypto';

import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/contracts/runtime-commands';
import { sealSecret } from '@libs/runtime/run/sealed-secret';

import { CellUnavailableError, HubRefused, MemberCleanupPendingError } from '../../shared/errors';
import type {
    AdmissionLimits,
    AdmissionPayload,
    AdmissionRecord,
    AdmissionRef,
    AdmissionStore,
    PhysicalAdmissionClient,
    PhysicalAdmissionRequest,
    PhysicalAdmissionResult,
    PhysicalAdmissionTicket,
} from '../../shared/admission/admission-contract';
import { InMemoryAdmissionStore } from '../../shared/admission/testing';
import { shopRunRequest } from '../../e2e/fixtures';
import { AdmissionCoordinator, type AdmissionScheduling } from './admission-coordinator';

// The coordinator against the real admission transitions (InMemoryAdmissionStore,
// the same base the Postgres store runs) and a cell that keeps the tickets it
// granted: every test asserts what is held afterwards (the permit, the ticket,
// the record's state and reason, what was scheduled or woken), not which
// method was called. Review T5.

const START = Date.parse('2026-11-07T12:00:00Z');
const LIMITS: AdmissionLimits & { leaseMs: number; retryMs: number } = {
    globalWaiting: 100,
    perOrgWaiting: 10,
    globalExecuting: 4,
    perOrgExecuting: 2,
    maxAttempts: 360,
    leaseMs: 30_000,
    retryMs: 5_000,
};

/** The cell's side of physical admission: the tickets it holds, which were redeemed, how the next cancel answers. */
class FakeCell implements PhysicalAdmissionClient {
    readonly held = new Map<string, { ticket: PhysicalAdmissionTicket; request: PhysicalAdmissionRequest }>();
    readonly redeemed = new Set<string>();
    reservations = 0;
    refusal?: { reason: 'no_capacity' | 'pair_too_large'; retryable: boolean };
    /** Errors the next cancels throw, in order; an empty list cancels. */
    cancelErrors: Error[] = [];
    /** Runs while the cell grants a ticket (a slow hub). */
    whileReserving?: () => void;

    constructor(private readonly now: () => number) {}

    async reserve(request: PhysicalAdmissionRequest): Promise<PhysicalAdmissionResult> {
        this.reservations++;
        this.whileReserving?.();
        if (this.refusal) return { status: 'refused', ...this.refusal };
        const ticket: PhysicalAdmissionTicket = {
            organizationId: request.organizationId,
            kind: request.kind,
            key: request.key,
            generation: request.generation,
            ticketOwnerToken: request.ticketOwnerToken,
            ticketId: `ticket-${this.reservations}`,
            cellId: 'cell-1',
            sessionEpoch: 'session-1',
            expiresAt: new Date(this.now() + 2 * 60_000).toISOString(),
            members: request.members.map((m) => ({ ...m, claimId: `claim-${m.idempotencyKey}` })),
        };
        this.held.set(ticket.ticketId, { ticket, request });
        return { status: 'reserved', ticket };
    }

    async redeem(ticket: PhysicalAdmissionTicket): Promise<boolean> {
        if (!this.held.has(ticket.ticketId)) return false;
        this.redeemed.add(ticket.ticketId);
        return true;
    }

    async cancel(ticket: PhysicalAdmissionTicket): Promise<void> {
        const error = this.cancelErrors.shift();
        if (error) throw error;
        this.held.delete(ticket.ticketId);
    }
}

function harness() {
    let now = START;
    const clock = () => now;
    const store = new InMemoryAdmissionStore({ now: () => new Date(now) });
    const cell = new FakeCell(clock);
    const coordinator = new AdmissionCoordinator(store, cell, LIMITS, () => new Date(now));
    const scheduled: Array<{ ref: AdmissionRef; generation: number; nextAt: string }> = [];
    const woken: string[] = [];
    const checkpoints: unknown[] = [];
    let crashAt: string | undefined;
    const ports: AdmissionScheduling = {
        step: async (name, fn) => {
            // A worker that dies before this durable step: nothing after it ran.
            if (name === crashAt) throw new Error(`worker died before ${name}`);
            const out = await fn();
            checkpoints.push(structuredClone(out));
            return out;
        },
        schedule: async (ref, generation, nextAt) => void scheduled.push({ ref, generation, nextAt }),
        wake: async (executionId) => void woken.push(executionId),
    };
    const accept = async (payload: AdmissionPayload): Promise<AdmissionRecord> => {
        const accepted = await store.accept(payload, LIMITS);
        if (accepted.status !== 'accepted') throw new Error(`fixture not accepted: ${accepted.status}`);
        return accepted.record;
    };
    const refOf = (r: AdmissionRecord): AdmissionRef => ({ organizationId: r.organizationId, kind: r.kind, key: r.key });
    const record = async (r: AdmissionRecord) => (await store.get(refOf(r)))!;
    /** A Run admitted up to its dispatch: permit and ticket held, the execution woken. */
    const dispatchedRun = async () => {
        const r = await accept(runPayload());
        await coordinator.attempt(refOf(r), 0, ports);
        return r;
    };
    return {
        store,
        cell,
        coordinator,
        ports,
        scheduled,
        woken,
        checkpoints,
        accept,
        refOf,
        record,
        dispatchedRun,
        advance: (ms: number) => void (now += ms),
        crashBefore: (step: string | undefined) => void (crashAt = step),
    };
}

const runPayload = (org = 'org-a'): AdmissionPayload => ({
    kind: 'run',
    request: shopRunRequest({ organizationId: org, requestedAt: new Date(START).toISOString() }),
});

const setupPayload = (over: Partial<RuntimeEnvironmentSetupRequested> = {}): AdmissionPayload => {
    const key = randomUUID();
    return {
        kind: 'setup',
        request: {
            key,
            organizationId: 'org-a',
            environmentId: 'env-a',
            teamId: 't',
            repositoryId: 'r',
            repositoryName: 'acme/shop',
            requestedAt: new Date(START).toISOString(),
            requestedBy: { userId: 'u' },
            repoToken: sealSecret('synthetic', Buffer.alloc(32, 1), key),
            ...over,
        },
    };
};

describe('admission attempts (durable, short)', () => {
    // Behavior: a setup the product already blocked has nothing to reserve: no permit, no ticket, rejected, and its execution woken to record why.
    it('rejects an already blocked setup without holding a permit or a ticket', async () => {
        const h = harness();
        const setup = await h.accept(setupPayload({ blocker: { kind: 'no_ref', message: 'no default branch' } }));

        await h.coordinator.attempt(h.refOf(setup), 0, h.ports);

        expect(await h.record(setup)).toMatchObject({ state: 'rejected', lastReason: 'unavailable', permitHeld: false, ticket: null });
        expect(h.cell.held.size).toBe(0);
        expect(h.woken).toEqual([setup.executionId]);
    });

    // Behavior: the ticket the cell holds is sized by the machine size the product command resolved.
    it("holds the setup's ticket at the resolved recipe CPU/RAM", async () => {
        const h = harness();
        const size = { cpus: 4, memoryMb: 8192 };
        const setup = await h.accept(setupPayload({ machineSize: size }));

        await h.coordinator.attempt(h.refOf(setup), 0, h.ports);

        const [held] = [...h.cell.held.values()];
        expect(held.request).toMatchObject({ size, members: [{ side: 'setup', idempotencyKey: `setup:${setup.key}` }] });
        expect((await h.record(setup)).ticket?.ticketId).toBe(held.ticket.ticketId);
    });

    // Behavior: the execution is woken only once the permit, the ticket and the dispatch are durable.
    it('dispatches with the permit and the ticket held, then wakes the execution', async () => {
        const h = harness();

        const run = await h.dispatchedRun();

        expect(await h.record(run)).toMatchObject({ state: 'dispatched', permitHeld: true, ticket: { ticketId: 'ticket-1' } });
        expect(h.cell.held.has('ticket-1')).toBe(true);
        expect(h.woken).toEqual([run.executionId]);
        expect(h.scheduled).toEqual([]);
    });

    // Behavior: a cell with no room now defers the attempt (no permit, no ticket), schedules the next, and checkpoints no sealed payload.
    it('defers a cell refusal for later without waking the execution or checkpointing the sealed payload', async () => {
        const h = harness();
        h.cell.refusal = { reason: 'no_capacity', retryable: true };
        const run = await h.accept(runPayload());

        await h.coordinator.attempt(h.refOf(run), 0, h.ports);

        expect(await h.record(run)).toMatchObject({ state: 'waiting', generation: 1, lastReason: 'no_capacity', permitHeld: false, ticket: null, nextAt: '2026-11-07T12:00:05.000Z' });
        expect(h.scheduled).toEqual([{ ref: h.refOf(run), generation: 1, nextAt: '2026-11-07T12:00:05.000Z' }]);
        expect(h.woken).toEqual([]);
        expect(JSON.stringify(h.checkpoints)).not.toContain('repoToken');
        expect(JSON.stringify(h.checkpoints)).not.toContain('diff');
    });

    // Behavior: with the execution budget full, the cell is never asked for a ticket; the attempt waits its turn.
    it('asks the cell for nothing while the combined execution budget is full', async () => {
        const h = harness();
        const coordinator = new AdmissionCoordinator(h.store, h.cell, { ...LIMITS, globalExecuting: 1 }, () => new Date(START));
        await coordinator.attempt(h.refOf(await h.accept(runPayload('org-b'))), 0, h.ports);
        expect(h.cell.reservations).toBe(1);
        const run = await h.accept(runPayload());

        await coordinator.attempt(h.refOf(run), 0, h.ports);

        expect(h.cell.reservations).toBe(1);
        expect(await h.record(run)).toMatchObject({ state: 'waiting', lastReason: 'global_limit', permitHeld: false, ticket: null });
        expect(h.scheduled).toHaveLength(1);
    });

    // Behavior: a permanent refusal is recorded as the Run's end and its execution is woken to report it; nothing is scheduled.
    it('records a permanent refusal and wakes the execution to report it', async () => {
        const h = harness();
        h.cell.refusal = { reason: 'pair_too_large', retryable: false };
        const run = await h.accept(runPayload());

        await h.coordinator.attempt(h.refOf(run), 0, h.ports);

        expect(await h.record(run)).toMatchObject({ state: 'rejected', lastReason: 'pair_too_large', ticket: null });
        expect(h.woken).toEqual([run.executionId]);
        expect(h.scheduled).toEqual([]);
    });

    // Behavior: an owner that lost its lease while the cell granted the ticket never cancels it: the generation-stable ticket stays for the new owner.
    it('a lost lease owner leaves the granted ticket on the cell and dispatches nothing', async () => {
        const h = harness();
        const run = await h.accept(runPayload());
        h.cell.whileReserving = () => h.advance(LIMITS.leaseMs + 1);

        await h.coordinator.attempt(h.refOf(run), 0, h.ports);

        expect(h.cell.held.size).toBe(1);
        expect(await h.record(run)).toMatchObject({ state: 'reserved', ticket: null });
        expect(h.woken).toEqual([]);
    });

    // Behavior: a worker that died after the ticket was attached resumes with the same ticket: no second reservation, then dispatch.
    it('repairs a death between attach and dispatch without reserving a second ticket', async () => {
        const h = harness();
        const run = await h.accept(runPayload());
        h.crashBefore('admission:dispatch');
        await expect(h.coordinator.attempt(h.refOf(run), 0, h.ports)).rejects.toThrow('worker died');
        expect(await h.record(run)).toMatchObject({ state: 'reserved', ticket: { ticketId: 'ticket-1' } });

        h.crashBefore(undefined);
        h.advance(LIMITS.leaseMs + 1);
        await h.coordinator.attempt(h.refOf(run), 0, h.ports);

        expect(h.cell.reservations).toBe(1);
        expect(await h.record(run)).toMatchObject({ state: 'dispatched', permitHeld: true, ticket: { ticketId: 'ticket-1' } });
        expect(h.woken).toEqual([run.executionId]);
    });
});

describe('admission execution start', () => {
    // Behavior: the execution does work only after the cell redeemed its ticket; the record is then running.
    it('redeems the attached ticket before the execution runs', async () => {
        const h = harness();
        const run = await h.dispatchedRun();

        const result = await h.coordinator.begin(h.refOf(run), run.executionId!);

        expect(result).toMatchObject({ status: 'ready', ticket: { ticketId: 'ticket-1' } });
        expect(h.cell.redeemed.has('ticket-1')).toBe(true);
        expect((await h.record(run)).state).toBe('running');
    });

    // Behavior: a ticket that expired before the execution started is refused; the cell redeems nothing and the record does not run.
    it('fails closed for a ticket that expired before the execution starts', async () => {
        const h = harness();
        const run = await h.dispatchedRun();
        h.advance(2 * 60_000 + 1);

        expect(await h.coordinator.begin(h.refOf(run), run.executionId!)).toMatchObject({ status: 'refused', reason: 'ticket_expired' });
        expect(h.cell.redeemed.size).toBe(0);
        expect((await h.record(run)).state).toBe('dispatched');
    });
});

describe('admission finish', () => {
    const running = async (h: ReturnType<typeof harness>) => {
        const run = await h.dispatchedRun();
        await h.coordinator.begin(h.refOf(run), run.executionId!);
        return run;
    };

    // Behavior: the permit stays held until the cell confirms the claims are gone; then it is freed and the ticket cleanup acknowledged.
    it('keeps the permit while the cell still cleans up, and frees it once the cleanup is done', async () => {
        const h = harness();
        const run = await running(h);
        h.cell.cancelErrors = [new MemberCleanupPendingError()];

        expect(await h.coordinator.finish(h.refOf(run), run.executionId!)).toEqual({ finished: false, cleanupFailed: false, cleanupPending: true });
        expect(await h.record(run)).toMatchObject({ state: 'running', permitHeld: true, ticket: { ticketId: 'ticket-1' } });
        expect(h.cell.held.has('ticket-1')).toBe(true);

        expect(await h.coordinator.finish(h.refOf(run), run.executionId!)).toEqual({ finished: true, cleanupFailed: false });
        expect(await h.record(run)).toMatchObject({ state: 'completed', permitHeld: false, ticket: null });
        expect(h.cell.held.size).toBe(0);
    });

    // Behavior: a cleanup that failed keeps the permit, and reports only a closed category, never the remote text.
    it.each([
        [new CellUnavailableError('secret-body'), 'cell_unavailable'],
        [new Error('member_cleanup_pending'), 'unexpected'],
        [new HubRefused({ code: 'forbidden', message: 'secret-body' }), 'hub_refused'],
    ])('keeps the permit on a failed cleanup and names it by category: %s', async (error, reason) => {
        const h = harness();
        const run = await running(h);
        h.cell.cancelErrors = [error, error];

        expect(await h.coordinator.cleanupTicket((await h.record(run)).ticket!)).toEqual({ status: 'failed', reason });
        expect(await h.coordinator.finish(h.refOf(run), run.executionId!)).toEqual({ finished: false, cleanupFailed: true, reason });
        expect(await h.record(run)).toMatchObject({ state: 'running', permitHeld: true });
    });

    // Behavior: when the store cannot acknowledge the cleanup, the permit is freed but the ticket stays on the record, discoverable for a retry.
    it('reports only a closed category when the durable cleanup acknowledgement fails', async () => {
        const h = harness();
        const run = await running(h);
        const failing: AdmissionStore = Object.assign(Object.create(h.store) as AdmissionStore, {
            acknowledgeTicketCleanup: async () => {
                throw new Error('database secret-body');
            },
        });
        const coordinator = new AdmissionCoordinator(failing, h.cell, LIMITS, () => new Date(START));

        expect(await coordinator.finish(h.refOf(run), run.executionId!)).toEqual({ finished: true, cleanupFailed: true, reason: 'store_unavailable' });
        expect(await h.record(run)).toMatchObject({ permitHeld: false, ticket: { ticketId: 'ticket-1' } });
    });

    // Behavior: a DBOS cancellation is not a cleanup result, and an execution that no longer owns the record frees nothing.
    it('does not turn a DBOS cancellation or a stale execution into a cleanup result', async () => {
        const h = harness();
        const run = await running(h);
        const cancelled = Object.assign(new Error('control'), { name: 'DBOSWorkflowCancelledError' });
        h.cell.cancelErrors = [cancelled];

        await expect(h.coordinator.cleanupTicket((await h.record(run)).ticket!)).rejects.toBe(cancelled);
        expect(await h.coordinator.finish(h.refOf(run), 'replacement-execution')).toEqual({ finished: false, cleanupFailed: false });
        expect(await h.record(run)).toMatchObject({ state: 'running', permitHeld: true, ticket: { ticketId: 'ticket-1' } });
        expect(h.cell.held.has('ticket-1')).toBe(true);
    });
});
