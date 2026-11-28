import type { RepoReader } from '../repo-reader';
import { entriesReaching } from './reach';

const treeOf = (files: Record<string, string>): RepoReader => ({
    list: async (dir) => {
        const prefix = dir ? `${dir}/` : '';
        const out = new Set<string>();
        for (const f of Object.keys(files)) if (f.startsWith(prefix)) out.add(f.slice(prefix.length).includes('/') ? `${f.slice(prefix.length).split('/')[0]}/` : f.slice(prefix.length));
        return [...out].sort();
    },
    read: async (path) => files[path] ?? null,
    paths: async () => Object.keys(files),
});

const BAG_BEFORE = `export function toBagItem(product: { name: string; description?: string }) {
    return { name: product.name, description: product.description ?? '' };
}
export function bagLabel(name: string) {
    return name.toUpperCase();
}
`;
const BAG_AFTER = BAG_BEFORE.replace("product.description ?? ''", 'product.description');

// A shop's functions codebase: two routes behind one app, served by one onRequest export that the codebase index groups.
const SHOP = {
    '.firebaserc': '{ "projects": { "default": "shop-dev" } }',
    'functions/order/src/api/utils/bag.ts': BAG_BEFORE,
    'functions/order/src/api/controllers/orders.ts': [
        "import { toBagItem } from '../utils/bag';",
        'export const createOrder = (req, res) => {',
        '    res.json({ items: req.body.products.map(toBagItem) });',
        '};',
        'export const listOrders = (req, res) => {',
        '    res.json([]);',
        '};',
    ].join('\n'),
    'functions/order/src/api/routes.ts': [
        "import { Router } from 'express';",
        "import { createOrder, listOrders } from './controllers/orders';",
        'const router = Router();',
        "router.get('/orders', listOrders);",
        "router.post('/orders', createOrder);",
        'export default router;',
    ].join('\n'),
    'functions/order/src/api/app.ts': ["import express from 'express';", "import router from './routes';", 'const app = express();', "app.use('/v1', router);", 'export default app;'].join('\n'),
    'functions/order/src/codebases/core.ts': ["import { onRequest } from 'firebase-functions/v2/https';", "import app from '../api/app';", 'export const checkout = onRequest(app);'].join('\n'),
    'functions/order/src/index.ts': "export * as order from './codebases/core';",
};

const lines = (text: string, needle: string) => [text.split('\n').findIndex((l) => l.includes(needle)) + 1];

describe('entries reaching a changed function', () => {
    it('ranks the route whose handler calls the changed function first, and serves it at the emulator URL of its export', async () => {
        const target = 'functions/order/src/api/utils/bag.ts';
        const { entries } = await entriesReaching({ base: treeOf(SHOP), head: treeOf({ ...SHOP, [target]: BAG_AFTER }) }, [target], [target], () => lines(BAG_AFTER, 'product.description'));
        expect(entries[target].map((e) => [e.route, e.calls])).toEqual([
            ['POST /v1/orders', 'yes'],
            ['GET /v1/orders', 'no'],
        ]);
        expect(entries[target][0]).toMatchObject({
            declared: 'POST /orders',
            file: 'functions/order/src/api/routes.ts',
            function: { exportName: 'order-checkout', region: 'us-central1' },
            urlPath: '/shop-dev/us-central1/order-checkout/v1/orders',
            chain: [target, 'functions/order/src/api/controllers/orders.ts', 'functions/order/src/api/routes.ts', 'functions/order/src/api/app.ts', 'functions/order/src/codebases/core.ts'],
        });
    });

    it('keeps the file-level order when the changed lines sit in no function', async () => {
        const target = 'functions/order/src/api/utils/bag.ts';
        const { entries } = await entriesReaching({ base: treeOf(SHOP) }, [target], [target], () => []);
        expect(entries[target].map((e) => e.calls)).toEqual(['unknown', 'unknown']);
    });

    it('does not rank a route whose handler calls another function of the same file', async () => {
        const target = 'functions/order/src/api/utils/bag.ts';
        const label = BAG_AFTER.replace('name.toUpperCase()', 'name.toLowerCase()');
        const { entries } = await entriesReaching({ base: treeOf(SHOP), head: treeOf({ ...SHOP, [target]: label }) }, [target], [target], () => lines(label, 'toLowerCase'));
        expect(entries[target].map((e) => e.calls)).toEqual(['no', 'no']);
    });

    it('reads the region of the onRequest options and falls back to the project placeholder', async () => {
        const files = {
            ...SHOP,
            '.firebaserc': '{}',
            'functions/order/src/codebases/core.ts': ["import { onRequest } from 'firebase-functions/v2/https';", "import app from '../api/app';", "export const checkout = onRequest({ region: 'southamerica-east1' }, app);"].join('\n'),
        };
        const target = 'functions/order/src/api/utils/bag.ts';
        const { entries } = await entriesReaching({ base: treeOf(files) }, [target], [target], () => []);
        expect(entries[target][0].urlPath).toBe('/<project>/southamerica-east1/order-checkout/v1/orders');
    });

    it('answers a route with no function when no onRequest export serves the app', async () => {
        const files = { ...SHOP, 'functions/order/src/codebases/core.ts': "import app from '../api/app';\nexport const checkout = app;" };
        const target = 'functions/order/src/api/utils/bag.ts';
        const { entries } = await entriesReaching({ base: treeOf(files) }, [target], [target], () => []);
        expect(entries[target][0]).not.toHaveProperty('urlPath');
        expect(entries[target][0].route).toBe('GET /orders');
    });

    it('ends on a cycle of imports', async () => {
        const files = {
            'src/a.ts': "import { b } from './b';\nexport const a = () => b();",
            'src/b.ts': "import { a } from './a';\nexport const b = () => a();",
            'src/routes.ts': "import { Router } from 'express';\nimport { a } from './a';\nconst router = Router();\nrouter.get('/a', a);",
        };
        const { entries } = await entriesReaching({ base: treeOf(files) }, ['src/a.ts'], ['src/a.ts'], () => [2]);
        expect(entries['src/a.ts'].map((e) => [e.route, e.calls])).toEqual([['GET /a', 'yes']]);
    });

    it('answers nothing for a file no route imports', async () => {
        const files = { 'src/a.ts': 'export const a = 1;' };
        expect((await entriesReaching({ base: treeOf(files) }, ['src/a.ts'], ['src/a.ts'])).entries).toEqual({});
    });
});
