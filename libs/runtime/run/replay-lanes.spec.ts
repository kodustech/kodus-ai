import type { ProbeResult } from '@libs/runtime/probe';

import { LANE_MAX_EVENTS, laneOf, normalizeLaneLabel, replayLanesOf } from './replay-lanes';

const STEP = '0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d';

const result = (over: Partial<ProbeResult> = {}): ProbeResult => ({
    stepId: STEP,
    executor: 'observer',
    imageId: 'img',
    http: { status: 200, headers: {}, body: '{}' },
    requests: [{ method: 'GET', route: '/orders', status: 200, at: 1 }],
    durationMs: 20,
    transport: 'ok',
    ...over,
});

const evidence = (logs: string[], extra: Partial<NonNullable<ProbeResult['evidence']>> = {}): NonNullable<ProbeResult['evidence']> => ({
    t0: '2026-11-06T12:00:00.000Z',
    windowMs: 20,
    logs: { lines: logs.length, truncated: false, tail: logs.map((text, i) => ({ at: 2 + i, service: 'api', text })) },
    db: { engine: 'postgres', service: 'db', tables: [], truncated: false },
    outbound: { calls: [], truncated: false },
    ...extra,
});

describe('replay lanes', () => {
    it('orders a lane request → logs → database → outbound → response, each on the round clock', () => {
        const lane = laneOf({
            side: 'pr',
            round: 1,
            stepId: STEP,
            result: result({
                evidence: evidence(['handled'], {
                    db: { engine: 'postgres', service: 'db', tables: [{ table: 'public.orders', inserted: 1, updated: 2, deleted: 0, rows: 1 }], truncated: false },
                    outbound: { calls: [{ at: 3, host: 'api.stripe.com', port: 443, allowed: false }], truncated: false },
                    refs: [{ type: 'logs', bytes: 10, sha256: 'a'.repeat(64), truncated: false, redactions: 0 }],
                }),
            }),
        });
        expect(lane.events).toEqual([
            { kind: 'request', at: 1, label: 'GET /orders → 200' },
            { kind: 'log', at: 2, service: 'api', label: 'handled' },
            { kind: 'db', at: 20, service: 'db', label: 'public.orders +1 ~2 -0' },
            { kind: 'outbound', at: 3, label: 'api.stripe.com:443 blocked' },
            { kind: 'response', at: 20, label: 'status 200' },
        ]);
        expect(lane.captured).toEqual({ requests: true, logs: true, db: true, outbound: true });
        expect(lane.artifacts).toEqual([{ type: 'logs', bytes: 10, truncated: false }]);
    });

    it('marks what a cell did not capture instead of reading it as nothing', () => {
        const lane = laneOf({ side: 'base', round: 1, stepId: STEP, result: result({ requests: [{ method: 'GET', route: '/orders', status: 200 }] }) });
        expect(lane.captured).toEqual({ requests: false, logs: false, db: false, outbound: false });
        expect(lane.events.map((e) => e.kind)).toEqual(['response']);
        expect(lane.t0).toBeUndefined();
    });

    it('keeps at most 40 events, dropping the oldest log lines first and always the response', () => {
        const lane = laneOf({ side: 'pr', round: 1, stepId: STEP, result: result({ evidence: evidence(Array.from({ length: 60 }, (_, i) => `line ${i}`)) }) });
        expect(lane.events).toHaveLength(LANE_MAX_EVENTS);
        expect(lane.truncated).toBe(true);
        expect(lane.events.at(-1)!.kind).toBe('response');
        expect(lane.events.find((e) => e.kind === 'log')!.label).toBe('line 22');
    });

    it('finds the first difference, ignoring ids and times in log lines', () => {
        const base = laneOf({ side: 'base', round: 1, stepId: STEP, result: result({ evidence: evidence(['req 1a2b3c4d5e6f7a8b9c took 3ms', 'saved order 41']) }) });
        const same = laneOf({ side: 'pr', round: 1, stepId: STEP, result: result({ evidence: evidence(['req 9f8e7d6c5b4a39281 took 7ms', 'saved order 42']) }) });
        expect(replayLanesOf(base, same).firstDifference).toBeUndefined();
        const pr = laneOf({ side: 'pr', round: 1, stepId: STEP, result: result({ evidence: evidence(['req 9f8e7d6c5b4a39281 took 7ms', 'TypeError: x is undefined']) }) });
        expect(replayLanesOf(base, pr).firstDifference).toMatchObject({ index: 2, kind: 'log', base: { label: 'saved order 41' }, pr: { label: 'TypeError: x is undefined' } });
        expect(normalizeLaneLabel('took 12.5ms at 2026-11-06')).toBe('took #ms at #-#-#');
    });

    it('never compares a block only one side captured, and reads the gate for the response', () => {
        const base = laneOf({ side: 'base', round: 1, stepId: STEP, result: result({ requests: [{ method: 'GET', route: '/orders', status: 200 }] }) });
        const pr = laneOf({ side: 'pr', round: 1, stepId: STEP, result: result({ evidence: evidence(['only here']) }) });
        expect(replayLanesOf(base, pr).firstDifference).toBeUndefined();
        // Same status, different body: the gate's differing fields mark the response.
        expect(replayLanesOf(base, pr, { responseDiffers: true }).firstDifference).toMatchObject({ kind: 'response' });
    });
});
