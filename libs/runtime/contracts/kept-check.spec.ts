import { KeptCheckSchema, keptCheckProbe, KeptChecksSchema, MAX_KEPT_CHECKS_PER_REPOSITORY } from './kept-check';

const http = {
    keptCheckId: '6f1c1d3e-2b7a-4c55-9a0e-3d2f4b5a6c7d',
    entryPoint: 'POST /orders',
    probe: {
        spec: { kind: 'http' as const, target: { service: 'web', port: 3000 }, method: 'POST' as const, path: '/orders', headers: { 'content-type': 'application/json' }, body: '{"items":[]}', timeoutMs: 5_000 },
        purpose: 'an empty cart is refused',
        expected: '400',
        compare: ['status' as const],
    },
    assertions: { kind: 'http' as const, status: 400 },
    differingFields: ['status'],
    sourcePrNumber: 42,
};

describe('KeptCheckSchema', () => {
    it('accepts an http check with the status main answered', () => {
        expect(KeptCheckSchema.safeParse(http).success).toBe(true);
    });

    it('refuses an http check without the status main answered: same on both sides could not be told from both wrong', () => {
        const { assertions: _a, ...rest } = http;
        expect(KeptCheckSchema.safeParse(rest).success).toBe(false);
    });

    it('refuses a sql or shell probe', () => {
        const sql = { ...http, assertions: undefined, probe: { ...http.probe, spec: { kind: 'sql', target: { service: 'db', port: 5432 }, query: 'select 1', timeoutMs: 1_000 } } };
        const shell = { ...http, assertions: undefined, probe: { ...http.probe, spec: { kind: 'shell', command: 'true', timeoutMs: 1_000 } } };
        expect(KeptCheckSchema.safeParse(sql).success).toBe(false);
        expect(KeptCheckSchema.safeParse(shell).success).toBe(false);
    });

    it('caps how many checks one Run carries', () => {
        expect(KeptChecksSchema.safeParse(Array.from({ length: MAX_KEPT_CHECKS_PER_REPOSITORY + 1 }, () => http)).success).toBe(false);
    });
});

describe('keptCheckProbe', () => {
    it('plays the kept spec as sent, under its own id', () => {
        const probe = keptCheckProbe(http);
        expect(probe.id).toBe(`kept:${http.keptCheckId}`);
        expect(probe.spec).toEqual(http.probe.spec);
    });
});
