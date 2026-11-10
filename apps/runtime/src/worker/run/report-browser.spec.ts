import type { GateStep } from '@libs/runtime/gate';
import type { BrowserLaneStep, ReplayLane, ReplayLanes } from '@libs/runtime/run';

import { browserFindingOf, observedOf } from './report';

// A browser probe in the report (ADR-071): steps passed per side from the
// gate's `steps` field, and the first step the gate's difference rests on,
// named by the probe's step, from the verdict's lanes.

const gate = (stepId: string, fields: Record<string, string>, transport: 'ok' | 'lost' = 'ok'): GateStep =>
    ({ stepId, probeId: 'p', side: 'base', round: 1, executor: 'observer', imageId: 'img', transport, vmHealth: 'ok', timedOut: false, fields, expectedHolds: true }) as GateStep;

const st = (index: number, kind: BrowserLaneStep['kind'], patch: Partial<BrowserLaneStep> = {}): BrowserLaneStep => ({
    index,
    kind,
    label: kind,
    ok: true,
    startMs: index * 100,
    endMs: index * 100 + 50,
    ...patch,
});

const lane = (side: 'base' | 'pr', steps: BrowserLaneStep[]): ReplayLane => ({
    side,
    round: 1,
    stepId: `${side}-1`,
    events: [],
    captured: { requests: false, logs: false, db: false, outbound: false },
    artifacts: [],
    truncated: false,
    browser: { steps, console: [], network: [], truncated: false },
});

const lanesOf = (base: BrowserLaneStep[], pr: BrowserLaneStep[]): ReplayLanes => ({ base: lane('base', base), pr: lane('pr', pr) });

describe('observedOf for a browser round', () => {
    it('counts the steps that passed of those played', () => {
        expect(observedOf([gate('a', { steps: 'ok,ok,ok,ok' })], ['a'])).toEqual({ browser: { passed: 4, total: 4 } });
        expect(observedOf([gate('b', { steps: 'ok,ok,ok,fail:mismatch' })], ['b'])).toEqual({ browser: { passed: 3, total: 4 } });
        expect(observedOf([gate('c', { steps: 'fail:navigation,fail:skipped' })], ['c'])).toEqual({ browser: { passed: 0, total: 2 } });
    });

    it('keeps the HTTP status first, a lost round as lost, and drops a field it cannot read', () => {
        expect(observedOf([gate('a', { status: '200', steps: 'ok' })], ['a'])).toEqual({ status: 200 });
        expect(observedOf([gate('a', { steps: 'ok' }, 'lost')], ['a'])).toEqual({ transport: 'lost' });
        expect(observedOf([gate('a', { steps: 'ok,<b>hi</b>' })], ['a'])).toBeUndefined();
        expect(observedOf([gate('a', { steps: Array(101).fill('ok').join(',') })], ['a'])).toBeUndefined();
    });
});

describe('browserFindingOf', () => {
    const base = [st(0, 'goto', { target: '/' }), st(1, 'getAttribute', { target: '#place', value: 'Place order' }), st(2, 'screenshot', { target: 'orders' })];

    it('a step that passes on main and fails on the PR, by its kind and selector, never its value', () => {
        const pr = [st(0, 'goto', { target: '/' }), st(1, 'expectText', { target: '#orders', ok: false, error: 'mismatch', value: 'monitor' })];
        const found = browserFindingOf({ lanes: lanesOf([st(0, 'goto', { target: '/' }), st(1, 'expectText', { target: '#orders', value: 'keyboard' })], pr), differingFields: ['steps', 'step.1.value'] });
        expect(found).toEqual({ browserStep: { index: 1, kind: 'expectText', target: '#orders', outcome: 'fails_on_pr' } });
        expect(JSON.stringify(found)).not.toMatch(/keyboard|monitor/);
    });

    it('fails on main, or on both sides differently', () => {
        const ok = [st(0, 'click', { target: '#a' })];
        const timeout = [st(0, 'click', { target: '#a', ok: false, error: 'timeout' })];
        const notFound = [st(0, 'click', { target: '#a', ok: false, error: 'not_found' })];
        expect(browserFindingOf({ lanes: lanesOf(timeout, ok), differingFields: ['steps'] }).browserStep?.outcome).toBe('fails_on_main');
        expect(browserFindingOf({ lanes: lanesOf(timeout, notFound), differingFields: ['steps'] }).browserStep?.outcome).toBe('fails_differently');
    });

    it('a value that differs while both steps pass, only when the gate counts that value', () => {
        const pr = [st(0, 'goto', { target: '/' }), st(1, 'getAttribute', { target: '#place', value: 'Buy' }), st(2, 'screenshot', { target: 'orders' })];
        expect(browserFindingOf({ lanes: lanesOf(base, pr), differingFields: ['step.1.value'] })).toEqual({
            browserStep: { index: 1, kind: 'getAttribute', target: '#place', outcome: 'value_differs' },
        });
        // A value the base rounds disagreed on is masked: the gate does not rest on it, so neither does the comment.
        expect(browserFindingOf({ lanes: lanesOf(base, pr), differingFields: ['pixels.2'] })).toEqual({});
    });

    it('the largest pixel change of the PR, in percent with one decimal, and none under the threshold', () => {
        const shot = (ratio: number) => [st(0, 'goto'), st(1, 'screenshot', { ratio }), st(2, 'screenshot', { ratio: ratio / 2 })];
        expect(browserFindingOf({ lanes: lanesOf(shot(0), shot(0.0134)), differingFields: ['pixels.1'] })).toEqual({ pixelDiffPercent: 1.3 });
        expect(browserFindingOf({ lanes: lanesOf(shot(0), shot(1)), differingFields: ['pixels.1'] })).toEqual({ pixelDiffPercent: 100 });
        expect(browserFindingOf({ lanes: lanesOf(shot(0), shot(0.0005)), differingFields: [] })).toEqual({});
    });

    it('a step without a target from an older lane is named by its kind only', () => {
        const found = browserFindingOf({ lanes: lanesOf([st(0, 'click')], [st(0, 'click', { ok: false, error: 'timeout' })]), differingFields: ['steps'] });
        expect(found.browserStep).toEqual({ index: 0, kind: 'click', outcome: 'fails_on_pr' });
    });

    it('nothing without both browser lanes (an HTTP probe, an older verdict)', () => {
        expect(browserFindingOf({ differingFields: ['steps'] })).toEqual({});
        const http = { ...lanesOf([], []), base: { ...lane('base', []), browser: undefined } } as ReplayLanes;
        expect(browserFindingOf({ lanes: http, differingFields: ['status'] })).toEqual({});
    });
});
