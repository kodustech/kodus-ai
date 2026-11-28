import type { Probe, ProbeResult } from '@libs/runtime/probe/probe.schema';

import { normalizeFields } from './probe-fields';

// The fields of a JSON body: every value the response carries is compared,
// however deep, and an empty object is a value too.

const probe = { id: 'p', origin: 'agent', purpose: 'p', expected: '200', compare: ['status'], spec: { kind: 'http', target: { service: 'app', port: 3000 }, method: 'GET', path: '/' } } as Probe;
const fieldsOf = (body: unknown) =>
    normalizeFields(probe, { stepId: '00000000-0000-4000-8000-000000000001', executor: 'observer', imageId: 'i', transport: 'ok', http: { status: 200, headers: {}, body: JSON.stringify(body) } } as ProbeResult);
const deep = (leaf: unknown, levels: number): unknown => (levels === 0 ? leaf : { a: deep(leaf, levels - 1) });

describe('normalizeFields on a JSON body', () => {
    it.each([9, 12, 30])('a value %i levels deep that changes gives different fields', (levels) => {
        expect(fieldsOf(deep(1, levels))).not.toEqual(fieldsOf(deep(2, levels)));
    });

    it('a value at the depth cap is compared as its whole subtree', () => {
        const fields = fieldsOf(deep({ x: 1 }, 9));
        expect(Object.values(fields)).toContain(JSON.stringify(deep({ x: 1 }, 0)));
    });

    it('an empty object is a value: {} and a missing key differ, and {} and {"k":1} differ', () => {
        expect(fieldsOf({ data: {} })).not.toEqual(fieldsOf({}));
        expect(fieldsOf({})).toEqual({ status: '200', json: '{}' });
        expect(fieldsOf({ data: {} })).not.toEqual(fieldsOf({ data: { k: 1 } }));
    });

    it('a shallow object keeps one field per value', () => {
        expect(fieldsOf({ id: 7, user: { name: 'ana' } })).toEqual({ status: '200', 'json.id': '7', 'json.user.name': '"ana"' });
    });
});
