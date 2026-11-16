import { QUEUE_TIMEOUT_MS } from '../run/run-orchestrator';
import { DBOS } from '@dbos-inc/dbos-sdk';

import { approvedRunWorkflowId, queuedPastLimit, RUN_WORKFLOW, RunEngineService, runPastLimit, SWEEP_BATCH } from './run-engine.service';

describe('sweep: a queued Run with no workflow', () => {
    const now = new Date('2026-10-31T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

    it('is a candidate only once queued past the queue limit and its margin', () => {
        expect(queuedPastLimit({ state: 'queued', requestedAt: ago(QUEUE_TIMEOUT_MS + 6 * 60_000) }, now)).toBe(true);
        expect(queuedPastLimit({ state: 'queued', requestedAt: ago(QUEUE_TIMEOUT_MS) }, now)).toBe(false);
        expect(queuedPastLimit({ state: 'awaiting_approval', requestedAt: ago(10 * QUEUE_TIMEOUT_MS) }, now)).toBe(false);
        expect(queuedPastLimit({ state: 'testing', requestedAt: ago(10 * QUEUE_TIMEOUT_MS) }, now)).toBe(false);
    });
});

describe('sweep: the 45 min of a Run that waited for room (ADR-070)', () => {
    const now = new Date('2026-10-31T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const MIN = 60_000;
    const waiting = (sinceMs: number, atMs: number) => ({ side: 'pr' as const, since: ago(sinceMs), at: ago(atMs), signature: 'no_capacity', message: 'no room' });

    it('a Run still waiting for room, or booting the side that just got it, is not past its 45 min', () => {
        // Booting 50 min ago, but the PR side waited 29 min and was refused for the last time 20 s ago: its machine boots now.
        expect(runPastLimit({ state: 'booting', bootingAt: ago(50 * MIN), capacityWait: waiting(50 * MIN, 20_000) }, now)).toBe(false);
        // Last refused 30 min ago: 30 min of boot and test since the side had room.
        expect(runPastLimit({ state: 'booting', bootingAt: ago(60 * MIN), capacityWait: waiting(60 * MIN, 30 * MIN) }, now)).toBe(false);
    });

    it('counts from the last refusal: 45 min after it the Run is past its limit, as one that never waited', () => {
        expect(runPastLimit({ state: 'booting', bootingAt: ago(80 * MIN), capacityWait: waiting(80 * MIN, 46 * MIN) }, now)).toBe(true);
        expect(runPastLimit({ state: 'testing', bootingAt: ago(46 * MIN), capacityWait: null }, now)).toBe(true);
        expect(runPastLimit({ state: 'testing', bootingAt: ago(44 * MIN) }, now)).toBe(false);
        // A projection from before `at` was recorded: from bootingAt, as before.
        expect(runPastLimit({ state: 'booting', bootingAt: ago(46 * MIN), capacityWait: { side: 'pr', since: ago(46 * MIN), signature: 'no_capacity', message: '' } }, now)).toBe(true);
    });
});

describe('sweep: the workflows of the live Runs, not a window of DBOS history', () => {
    afterEach(() => jest.restoreAllMocks());

    // A window of the last 200 stopped workflows of the last 6 h filled with Runs already final; a
    // live Run past it, or older than the window, was never swept.
    it('asks DBOS about every live Run in batches and stops the one whose workflow stopped, however old', async () => {
        const now = new Date('2026-11-16T12:00:00Z');
        const live = Array.from({ length: 250 }, (_, i) => ({ runId: `run-${i}`, organizationId: 'org-a', state: 'testing', requestedAt: now.toISOString(), bootingAt: now.toISOString() }));
        const asked: string[][] = [];
        jest.spyOn(DBOS, 'listWorkflows').mockImplementation(async (input: any) => {
            asked.push(input.workflowIDs);
            expect(input).not.toHaveProperty('startTime');
            // run-249 errored 7 h ago, past the old window.
            return input.workflowIDs.includes('run-249') ? [{ workflowID: 'run-249', workflowName: RUN_WORKFLOW, status: 'ERROR', createdAt: now.getTime() - 7 * 3_600_000 }] as any : [];
        });
        jest.spyOn(DBOS, 'getWorkflowStatus').mockResolvedValue({} as any);
        const projection = { listLive: async () => live, get: async (id: string) => live.find((r) => r.runId === id) ?? null };
        const engine = new RunEngineService({ sweeper: false } as any, {} as any, projection as any, {} as any, {} as any, {} as any);
        const stop = jest.spyOn(engine, 'stop').mockResolvedValue(undefined as any);
        await engine.sweep(now);
        expect(asked.every((ids) => ids.length <= SWEEP_BATCH)).toBe(true);
        expect(asked.flat()).toHaveLength(500);
        expect(asked.flat()).toEqual(expect.arrayContaining(['run-0', approvedRunWorkflowId('run-0'), 'run-249']));
        expect(stop).toHaveBeenCalledTimes(1);
        expect(stop.mock.calls[0][1]).toBe('errored');
    });
});
