import { HARD_EXPIRY_MINUTES } from '@libs/runtime/environment/environment-runtime';
import { STUCK_STATES } from '@libs/runtime/telemetry/catalog';

import {
    RUNTIME_LIMITS,
    SETUP_CEILING_MS,
    SETUP_NO_PROGRESS_MS,
    STUCK_BOUNDS,
    STUCK_GRACE_MS,
    stuckAdmissions,
    stuckCells,
    stuckClaims,
    stuckRuns,
    stuckSetups,
    stuckWorkflows,
} from './stuck';

// Each bound of the hang detector is crossed with a fake clock: one
// millisecond inside it (bound + grace) the item is not stuck, one past it is.

const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms);
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const MIN = 60_000;
const edge = (bound: number) => [at(bound + STUCK_GRACE_MS), at(bound + STUCK_GRACE_MS + 1)] as const;

describe('hang bounds', () => {
    it.each([
        ['queued', RUNTIME_LIMITS.queueTimeoutMs + RUNTIME_LIMITS.neverStartedMarginMs],
        ['awaiting_approval', RUNTIME_LIMITS.approvalWaitMs],
    ])('a Run %s is stuck once its bound from requestedAt has passed', (state, bound) => {
        const run = { runId: 'r1', organizationId: 'o1', state, requestedAt: iso(0) };
        const [inside, outside] = edge(bound);
        expect(stuckRuns([run], inside)).toEqual([]);
        expect(stuckRuns([run], outside)).toEqual([expect.objectContaining({ subject: 'run', state, runId: 'r1', boundMs: bound })]);
    });

    it('a queued Run, its ENQUEUED workflow and its PENDING Run workflow follow the queue limit the worker is configured with', () => {
        const queueTimeoutMs = 2 * 60 * MIN;
        const extra = queueTimeoutMs - RUNTIME_LIMITS.queueTimeoutMs;
        const run = { runId: 'r1', organizationId: 'o1', state: 'queued', requestedAt: iso(0) };
        const [inside, outside] = edge(queueTimeoutMs + RUNTIME_LIMITS.neverStartedMarginMs);
        expect(stuckRuns([run], inside, { queueTimeoutMs })).toEqual([]);
        expect(stuckRuns([run], outside, { queueTimeoutMs })).toEqual([expect.objectContaining({ boundMs: queueTimeoutMs + RUNTIME_LIMITS.neverStartedMarginMs })]);
        for (const [status, name, bound] of [
            ['ENQUEUED', 'runtimeRun', RUNTIME_LIMITS.queueTimeoutMs + RUNTIME_LIMITS.neverStartedMarginMs],
            ['PENDING', 'runtimeRun', RUNTIME_LIMITS.queueTimeoutMs + RUNTIME_LIMITS.runTimeoutMs + RUNTIME_LIMITS.publishRetriesMs],
        ] as const) {
            const wf = { workflowId: 'w1', name, status, createdAt: T0 };
            const [wIn, wOut] = edge(bound + extra);
            expect(stuckWorkflows([wf], wIn, { queueTimeoutMs })).toEqual([]);
            expect(stuckWorkflows([wf], wOut, { queueTimeoutMs })).toEqual([expect.objectContaining({ workflowId: 'w1', boundMs: bound + extra })]);
        }
    });

    it.each(['booting', 'testing'])('a Run %s counts 45 min from the later of bootingAt and its last wait for room', (state) => {
        const run = { runId: 'r1', organizationId: 'o1', state, requestedAt: iso(0), bootingAt: iso(10 * MIN), capacityWait: { at: iso(20 * MIN) } };
        const [inside, outside] = edge(20 * MIN + RUNTIME_LIMITS.runTimeoutMs);
        expect(stuckRuns([run], inside)).toEqual([]);
        expect(stuckRuns([run], outside)).toEqual([expect.objectContaining({ state, since: iso(20 * MIN), boundMs: RUNTIME_LIMITS.runTimeoutMs })]);
    });

    it('never calls a final Run stuck', () => {
        expect(stuckRuns([{ runId: 'r1', organizationId: 'o1', state: 'regression', requestedAt: iso(0) }], at(30 * 24 * 60 * MIN))).toEqual([]);
    });

    it('a setup is stuck past its whole ceiling, or past one boot without a saved step', () => {
        const setup = { environmentId: 'e1', organizationId: 'o1', setupKey: 'k1', state: 'setting_up', requestedAt: iso(0), updatedAt: iso(0) };
        const [quietInside, quietOutside] = edge(SETUP_NO_PROGRESS_MS);
        expect(stuckSetups([setup], quietInside)).toEqual([]);
        expect(stuckSetups([setup], quietOutside)).toEqual([expect.objectContaining({ subject: 'setup', state: 'no_progress', setupKey: 'k1' })]);
        const busy = { ...setup, updatedAt: iso(SETUP_CEILING_MS) };
        const [inside, outside] = edge(SETUP_CEILING_MS);
        expect(stuckSetups([busy], inside)).toEqual([]);
        expect(stuckSetups([busy], outside)).toEqual([expect.objectContaining({ state: 'setting_up', boundMs: SETUP_CEILING_MS })]);
    });

    it('the setup queue is stuck when several setups wait and none saved a step for one boot', () => {
        const s = (k: string, updated: number) => ({ environmentId: k, organizationId: 'o1', setupKey: k, state: 'setting_up', requestedAt: iso(0), updatedAt: iso(updated) });
        const [inside, outside] = edge(5 * MIN + SETUP_NO_PROGRESS_MS);
        expect(stuckSetups([s('a', 0), s('b', 5 * MIN)], inside).filter((i) => i.subject === 'setup_queue')).toEqual([]);
        expect(stuckSetups([s('a', 0), s('b', 5 * MIN)], outside).filter((i) => i.subject === 'setup_queue')).toEqual([expect.objectContaining({ state: 'no_progress', since: iso(5 * MIN) })]);
    });

    it.each([
        ['runtime', 'base', 15],
        ['runtime', 'pr', 30],
        ['setup', 'setup', HARD_EXPIRY_MINUTES.setup - 1],
        ['sandbox', 'pr', 2],
    ])('a %s claim (%s) pending is stuck past the ready wait plus the worker’s minute', (consumer, side, minutes) => {
        const claim = { claimId: 'c1', cellId: 'cell', orgId: 'o1', side, state: 'pending', consumer, stateChangedAt: iso(0), hardExpiresAt: iso(10 * 24 * 60 * MIN) };
        const [inside, outside] = edge((minutes + 1) * MIN);
        expect(stuckClaims([claim], inside)).toEqual([]);
        expect(stuckClaims([claim], outside)).toEqual([expect.objectContaining({ subject: consumer === 'sandbox' ? 'sandbox' : 'claim', state: 'pending', claimId: 'c1' })]);
    });

    it.each(['bound', 'held', 'blocked', 'failed', 'compromised'])('an open claim %s is stuck once its hard ceiling passed (the reap missed it)', (state) => {
        const claim = { claimId: 'c1', cellId: 'cell', orgId: 'o1', side: 'pr', state, consumer: 'runtime', stateChangedAt: iso(0), hardExpiresAt: iso(60 * MIN) };
        const [inside, outside] = edge(60 * MIN);
        expect(stuckClaims([claim], inside)).toEqual([]);
        expect(stuckClaims([claim], outside)).toEqual([expect.objectContaining({ state, since: iso(60 * MIN) })]);
        expect(stuckClaims([{ ...claim, state: 'released' }], outside)).toEqual([]);
    });

    it('an admission request is stuck past its own deadline, a fork past its approval deadline', () => {
        const waiting = { organizationId: 'o1', kind: 'run', key: 'r1', state: 'waiting', deadlineAt: iso(RUNTIME_LIMITS.admissionWaitMs), createdAt: iso(0) };
        const approval = { organizationId: 'o1', kind: 'run', key: 'r2', state: 'awaiting_approval', approvalDeadlineAt: iso(RUNTIME_LIMITS.approvalWaitMs), createdAt: iso(0) };
        const [inside, outside] = edge(RUNTIME_LIMITS.admissionWaitMs);
        expect(stuckAdmissions([waiting, approval], inside)).toEqual([]);
        expect(stuckAdmissions([waiting, approval], outside)).toEqual([expect.objectContaining({ subject: 'admission', state: 'waiting', runId: 'r1' })]);
        const [, approvalOutside] = edge(RUNTIME_LIMITS.approvalWaitMs);
        expect(stuckAdmissions([approval], approvalOutside)).toEqual([expect.objectContaining({ state: 'awaiting_approval', runId: 'r2' })]);
    });

    it.each(STUCK_BOUNDS.filter((b) => b.subject === 'workflow').map((b) => [b.state, b.boundMs as number]))('a DBOS workflow %s is stuck past its bound', (state, bound) => {
        const [status, name] = state.split(' ');
        const wf = { workflowId: 'w1', name: name ?? 'runtimeRun', status, createdAt: T0 };
        const [inside, outside] = edge(bound);
        expect(stuckWorkflows([wf], inside)).toEqual([]);
        expect(stuckWorkflows([wf], outside)).toEqual([expect.objectContaining({ subject: 'workflow', state, workflowId: 'w1' })]);
    });

    it('a cell whose session says connected with no heartbeat past the hub’s silence limit is stuck', () => {
        const cell = { cellId: 'cell-a', lastHeartbeatAt: iso(0) };
        const [inside, outside] = edge(RUNTIME_LIMITS.cellSilenceMs + 2 * RUNTIME_LIMITS.silenceTickMs);
        expect(stuckCells([cell], inside)).toEqual([]);
        expect(stuckCells([cell], outside)).toEqual([expect.objectContaining({ subject: 'cell', state: 'connected_silent', cellId: 'cell-a' })]);
        expect(stuckCells([{ ...cell, disconnectedAt: iso(1) }], outside)).toEqual([]);
    });

    it('names every state it can report in the taxonomy, so the metric label is never "other"', () => {
        const states = STUCK_BOUNDS.flatMap((b) => b.state.split('|'));
        expect(states.filter((s) => !(STUCK_STATES as readonly string[]).includes(s))).toEqual([]);
    });
});
