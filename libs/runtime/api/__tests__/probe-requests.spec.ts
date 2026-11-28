import { probeRequestsOf } from '../application/use-cases/get-run.use-case';

describe('probeRequestsOf', () => {
    const reproduction = {
        probes: [
            {
                probeId: 'orders',
                entryPoint: 'POST /orders',
                purpose: 'a coupon applies before tax',
                expected: '201 with the total',
                spec: { kind: 'http', target: { service: 'web', port: 3000 }, method: 'POST', path: '/orders', body: '{"card":"4242"}', timeoutMs: 1000 },
            },
            { probeId: 'rows', entryPoint: 'db', purpose: 'p', expected: 'e', spec: { kind: 'sql', target: { service: 'db', port: 5432 }, query: 'select secret from users' } },
            { probeId: 'cart', entryPoint: 'GET /cart', purpose: 'p', expected: 'e', spec: { kind: 'browser', steps: [{ goto: '/cart' }, { fill: ['#pw', 'hunter2'] }], viewport: { width: 390, height: 844 } } },
        ],
    } as any;

    it('keeps the shape of each request, never a body, a query or browser input', () => {
        const out = probeRequestsOf(reproduction);
        expect(out.orders).toEqual({ kind: 'http', method: 'POST', service: 'web', port: 3000, path: '/orders', purpose: 'a coupon applies before tax', expected: '201 with the total' });
        expect(out.rows).toEqual({ kind: 'sql', purpose: 'p', expected: 'e' });
        expect(out.cart).toEqual({ kind: 'browser', path: '/cart', purpose: 'p', expected: 'e' });
        expect(JSON.stringify(out)).not.toMatch(/4242|select secret|hunter2/);
    });

    it('is empty without a reproduction', () => {
        expect(probeRequestsOf(undefined)).toEqual({});
    });
});
