import type { Probe, ProbeResult } from '@libs/runtime/probe';

import { effectiveCompare, expectedHolds, normalizeFields, toGateStep } from './probe-fields';

const httpProbe = (compare: Probe['compare']): Probe =>
    ({
        id: 'orders',
        origin: 'agent',
        purpose: 'p',
        expected: '200',
        compare,
        spec: { kind: 'http', target: { service: 'app', port: 3000 }, method: 'GET', path: '/orders/1' },
    }) as Probe;

const result = (status: number, body: string): ProbeResult => ({
    stepId: '00000000-0000-4000-8000-000000000001',
    executor: 'observer',
    imageId: 'img',
    http: { status, headers: {}, body },
    requests: [{ method: 'GET', route: '/orders/:id', status }],
    durationMs: 1,
    transport: 'ok',
});

describe('compared fields: a floor the agent cannot drop', () => {
    it('evaluates HTTP assertions independently of descriptive expected text', () => {
        const probe = { ...httpProbe(['status']), expected: "400 with error 'item and quantity are required'" };
        const assertions = { kind: 'http' as const, status: 400, bodyIncludes: 'item and quantity are required' };
        const gate = (status: number, body: string) => toGateStep({ probe, assertions, side: 'base', round: 1, stepId: 'x', result: { ...result(status, body), vmHealth: 'ok' } });
        expect(gate(400, '{"error":"item and quantity are required"}').expectedHolds).toBe(true);
        expect(gate(201, '{"error":"item and quantity are required"}').expectedHolds).toBe(false);
        expect(gate(400, '{"error":"another error"}').expectedHolds).toBe(false);
    });

    it('legacy HTTP prose that cannot be demonstrated is unknown, never false', () => {
        const prose = { ...httpProbe(['status']), expected: '201 with the created order' };
        expect(expectedHolds(prose, result(201, '{"id":1}'))).toBeUndefined();
        expect(expectedHolds({ ...prose, expected: '' }, result(201, '{"id":1}'))).toBeUndefined();
        expect(expectedHolds({ ...prose, expected: 'created order' }, result(201, 'the created order'))).toBe(true);
        expect(expectedHolds({ ...prose, expected: '201' }, result(201, '{}'))).toBe(true);
        expect(expectedHolds({ ...prose, expected: '201' }, result(400, '{}'))).toBe(false);
    });

    it('an HTTP probe always compares status and body, whatever compare the agent wrote', () => {
        expect(effectiveCompare(httpProbe(['status']))).toEqual(['status', 'json']);
        expect(normalizeFields(httpProbe(['status']), result(200, '{"total":10}'))).toEqual({ status: '200', 'json.total': '10' });
    });

    it('a body that is not JSON still counts, by its digest', () => {
        const a = normalizeFields(httpProbe(['status']), result(200, '<p>10</p>'));
        const b = normalizeFields(httpProbe(['status']), result(200, '<p>11</p>'));
        expect(a.json).toBe('not_json');
        expect(a['body.sha256']).not.toBe(b['body.sha256']);
    });

    it('the gate step carries the observer request log (S-32)', () => {
        const s = toGateStep({ probe: httpProbe(['status']), side: 'pr', round: 1, stepId: 'x', result: { ...result(200, '{}'), vmHealth: 'ok' } });
        expect(s.requests).toEqual([{ method: 'GET', route: '/orders/:id' }]);
    });
});

describe('browser probes: the closed outcomes (ADR-071)', () => {
    const browserProbe = (compare: Probe['compare']): Probe =>
        ({
            id: 'orders-page',
            origin: 'agent',
            purpose: 'the orders page lists the orders',
            expected: 'the list shows keyboard',
            compare,
            spec: {
                kind: 'browser',
                steps: [{ goto: '/' }, { screenshot: 'orders' }, { expectText: ['#orders', 'keyboard'] }, { getAttribute: ['#place', 'type'] }],
                viewport: { width: 1280, height: 720 },
                timeoutMs: 30_000,
            },
        }) as Probe;
    const browserResult = (over: { text?: string; ok?: boolean; ratio?: number; pixels?: boolean } = {}): ProbeResult => ({
        stepId: '00000000-0000-4000-8000-000000000002',
        executor: 'observer',
        imageId: 'img',
        browser: {
            network: [],
            console: [],
            steps: [
                { index: 0, kind: 'goto', ok: true, startMs: 0, endMs: 10 },
                { index: 1, kind: 'screenshot', ok: true, startMs: 10, endMs: 20, screenshot: 0 },
                over.ok === false
                    ? { index: 2, kind: 'expectText', ok: false, startMs: 20, endMs: 30, value: over.text ?? '', error: 'mismatch' }
                    : { index: 2, kind: 'expectText', ok: true, startMs: 20, endMs: 30, value: over.text ?? 'keyboard × 2' },
                { index: 3, kind: 'getAttribute', ok: true, startMs: 30, endMs: 31, value: 'submit' },
            ],
            ...(over.pixels === false ? {} : { pixels: [{ screenshot: 0, ratio: over.ratio ?? 0, changed: 0, total: 921_600, sizeDiffers: false }] }),
        },
        requests: [],
        durationMs: 40,
        transport: 'ok',
    });

    it('always compares the steps, what they read and the pixels, whatever compare says', () => {
        expect(effectiveCompare(browserProbe(['dom']))).toEqual(['pixels', 'dom']);
        expect(normalizeFields(browserProbe(['dom']), browserResult({ ratio: 0.0004 }))).toEqual({
            steps: 'ok,ok,ok,ok',
            'step.2.value': 'keyboard × 2',
            'step.3.value': 'submit',
            'pixels.1': 'same',
        });
    });

    it('a screenshot over the threshold is changed; the baseline round is same by definition; unmeasured has no field', () => {
        expect(normalizeFields(browserProbe(['pixels']), browserResult({ ratio: 0.04 }))['pixels.1']).toBe('changed');
        expect(normalizeFields(browserProbe(['pixels']), browserResult({ pixels: false }), { baselineRound: true })['pixels.1']).toBe('same');
        expect(normalizeFields(browserProbe(['pixels']), browserResult({ pixels: false }))).not.toHaveProperty('pixels.1');
    });

    it('a failing step is its outcome and why, and the probe expected holds only when every step passed', () => {
        const failed = toGateStep({ probe: browserProbe(['pixels']), side: 'pr', round: 1, stepId: 's', result: { ...browserResult({ ok: false, text: 'No orders yet' }), vmHealth: 'ok' } });
        expect(failed.fields.steps).toBe('ok,ok,fail:mismatch,ok');
        expect(failed.fields['step.2.value']).toBe('No orders yet');
        expect(failed.expectedHolds).toBe(false);
        expect(toGateStep({ probe: browserProbe(['pixels']), side: 'base', round: 1, stepId: 's', result: { ...browserResult(), vmHealth: 'ok' } }).expectedHolds).toBe(true);
    });
});
