import type { FakeEnvironment } from '@libs/runtime/environment';

// Synthetic environments for the fake cell and the tests. No customer data:
// a toy shop whose PR turns the empty-cart 400 into a 500.

export const SHOP_IMAGE = 'img-shop-1';

export const SCENARIOS: Record<string, FakeEnvironment> = {
    shop: {
        imageId: SHOP_IMAGE,
        expose: [{ service: 'web', port: 3000, kind: 'http' }],
        probes: {
            'orders-empty-cart': {
                base: () => ({ http: { status: 400, headers: {}, body: '{"error":"cart is empty"}' } }),
                pr: () => ({ http: { status: 500, headers: {}, body: '{"error":"internal"}' } }),
            },
            'orders-list': {
                base: (round) => ({ http: { status: 200, headers: {}, body: `{"items":[],"requestId":"b${round}"}` } }),
                pr: (round) => ({ http: { status: 200, headers: {}, body: `{"items":[],"requestId":"p${round}"}` } }),
            },
        },
        exec: (command) => (command.includes('routes') ? { stdout: 'GET /orders\nPOST /orders\n' } : { stdout: '' }),
    },
    'shop-pr-broken': {
        imageId: SHOP_IMAGE,
        expose: [{ service: 'web', port: 3000, kind: 'http' }],
    },
    broken: {
        imageId: SHOP_IMAGE,
        expose: [],
        blockers: [{ kind: 'missing_env', signature: 'PAYMENTS_KEY', message: 'the app needs a fake for the payments API' }],
    },
};
