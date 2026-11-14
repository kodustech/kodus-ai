import { QUEUE_TIMEOUT_MS } from '../run/run-orchestrator';
import { queuedPastLimit, runPastLimit } from './run-engine.service';

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
