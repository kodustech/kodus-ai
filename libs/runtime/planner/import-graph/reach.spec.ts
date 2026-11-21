import type { RepoReader } from '../repo-reader';
import { RepoPathError } from '../repo-reader';
import { IMPORT_GRAPH_LIMITS, ImportGraphCache, routesReaching } from './reach';

const treeOf = (files: Record<string, string>, opts: { paths?: boolean; batch?: boolean } = {}): RepoReader & { reads: string[]; calls: number } => {
    const reads: string[] = [];
    const reader: RepoReader & { reads: string[]; calls: number } = {
        reads,
        calls: 0,
        list: async (dir) => {
            reader.calls++;
            const prefix = dir ? `${dir}/` : '';
            const out = new Set<string>();
            for (const f of Object.keys(files)) if (f.startsWith(prefix)) out.add(f.slice(prefix.length).includes('/') ? `${f.slice(prefix.length).split('/')[0]}/` : f.slice(prefix.length));
            return [...out].sort();
        },
        read: async (path) => {
            reader.calls++;
            reads.push(path);
            return files[path] ?? null;
        },
    };
    if (opts.paths !== false) reader.paths = async () => (reader.calls++, Object.keys(files));
    // One call for many files, as a platform's batch read (GraphQL objects, an archive) answers them.
    if (opts.batch)
        reader.readMany = async (paths) => {
            reader.calls++;
            reads.push(...paths);
            return new Map(paths.map((p) => [p, files[p] ?? null]));
        };
    return reader;
};

const NEST = {
    'src/orders/orders.service.ts': 'export class OrdersService { total() { return 1; } }',
    'src/orders/orders.controller.ts': "import { Controller, Get } from '@nestjs/common';\nimport { OrdersService } from './orders.service';\n@Controller('orders')\nexport class OrdersController {\n  @Get(':id')\n  one() {}\n}",
    'src/orders/orders.module.ts': "import { OrdersController } from './orders.controller';\nexport class OrdersModule {}",
    'src/orders/orders.service.spec.ts': "import { OrdersService } from './orders.service';\napp.get('/from-a-test', x);",
};

describe('routes that reach a changed file through its importers', () => {
    it('maps a changed service to the controller route that imports it', async () => {
        expect(await routesReaching({ base: treeOf(NEST) }, ['src/orders/orders.service.ts'])).toEqual({
            'src/orders/orders.service.ts': [{ route: 'GET /orders/:id', file: 'src/orders/orders.controller.ts', hops: 1 }],
        });
    });

    it('maps a helper to a route two imports away', async () => {
        const files = {
            'src/lib/money.ts': 'export const cents = (n) => n * 100;',
            'src/billing/charge.ts': "import { cents } from '../lib/money';\nexport const charge = () => cents(1);",
            'src/routes/billing.ts': "import { Router } from 'express';\nimport { charge } from '../billing/charge';\nconst router = Router();\nrouter.post('/billing/charge', charge);",
        };
        expect(await routesReaching({ base: treeOf(files) }, ['src/lib/money.ts'])).toEqual({
            'src/lib/money.ts': [{ route: 'POST /billing/charge', file: 'src/routes/billing.ts', hops: 2 }],
        });
    });

    it('maps a component to the Next page that imports it through a tsconfig alias', async () => {
        const files = {
            'apps/web/next.config.js': 'module.exports = {};',
            'apps/web/tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }',
            'apps/web/src/components/cart.tsx': 'export const Cart = () => null;',
            'apps/web/src/app/(shop)/cart/page.tsx': "import { Cart } from '@/components/cart';\nexport default function Page() { return <Cart />; }",
        };
        expect(await routesReaching({ base: treeOf(files) }, ['apps/web/src/components/cart.tsx'])).toEqual({
            'apps/web/src/components/cart.tsx': [{ route: 'GET /cart', file: 'apps/web/src/app/(shop)/cart/page.tsx', hops: 1 }],
        });
    });

    it('maps a module of one workspace package to the route of another that imports the package', async () => {
        const files = {
            'packages/shared/package.json': '{ "name": "@acme/shared", "main": "dist/index.js" }',
            'packages/shared/src/index.ts': "export * from './tax';",
            'packages/shared/src/tax.ts': 'export const tax = 0.1;',
            'apps/api/src/app.ts': "import { tax } from '@acme/shared';\napp.get('/tax', (_, res) => res.json(tax));",
        };
        expect(await routesReaching({ base: treeOf(files) }, ['packages/shared/src/tax.ts'])).toEqual({
            'packages/shared/src/tax.ts': [{ route: 'GET /tax', file: 'apps/api/src/app.ts', hops: 2 }],
        });
    });

    it('does not count the routes of an app root that imports the changed file only through many other files', async () => {
        const files: Record<string, string> = {
            'src/util.ts': 'export const u = 1;',
            'src/feature.ts': "import { u } from './util';\nexport const f = u;",
        };
        const imports = ["import { f } from './feature';"];
        for (let i = 0; i < IMPORT_GRAPH_LIMITS.hubImports; i++) {
            files[`src/mod${i}.ts`] = 'export const m = 1;';
            imports.push(`import './mod${i}';`);
        }
        files['src/server.ts'] = `${imports.join('\n')}\napp.get('/timezones', tz);`;
        expect(await routesReaching({ base: treeOf(files) }, ['src/util.ts'])).toEqual({});
    });

    it('maps a changed file that is itself a page to its own route', async () => {
        const files = { 'next.config.mjs': 'export default {};', 'pages/checkout.tsx': 'export default function Checkout() { return null; }' };
        expect(await routesReaching({ base: treeOf(files) }, ['pages/checkout.tsx'])).toEqual({ 'pages/checkout.tsx': [{ route: 'GET /checkout', file: 'pages/checkout.tsx', hops: 0 }] });
    });

    it('reads the changed file at the head, where its new import of the changed helper is', async () => {
        const base = { 'src/util.ts': 'export const u = 1;', 'src/server.ts': "app.get('/ping', ok);" };
        const head = { ...base, 'src/server.ts': "import { u } from './util';\napp.get('/ping', ok);" };
        expect(await routesReaching({ base: treeOf(base), head: treeOf(head) }, ['src/util.ts', 'src/server.ts'], ['src/util.ts'])).toEqual({
            'src/util.ts': [{ route: 'GET /ping', file: 'src/server.ts', hops: 1 }],
        });
    });

    it('does not count a test that imports the changed file as a route that reaches it', async () => {
        const files = { 'src/orders/orders.service.ts': NEST['src/orders/orders.service.ts'], 'src/orders/orders.service.spec.ts': NEST['src/orders/orders.service.spec.ts'] };
        expect(await routesReaching({ base: treeOf(files) }, ['src/orders/orders.service.ts'])).toEqual({});
    });

    it('finds no route past the depth bound', async () => {
        const files: Record<string, string> = { 'src/m0.ts': 'export const v = 0;' };
        for (let i = 1; i <= IMPORT_GRAPH_LIMITS.depth + 1; i++) files[`src/m${i}.ts`] = `import { v } from './m${i - 1}';\nexport const w = v;`;
        files['src/server.ts'] = `import { w } from './m${IMPORT_GRAPH_LIMITS.depth + 1}';\napp.get('/deep', ok);`;
        expect(await routesReaching({ base: treeOf(files) }, ['src/m0.ts'])).toEqual({});
    });

    it('reads no more files than the read bound', async () => {
        const files: Record<string, string> = { 'src/target.ts': 'export const t = 1;' };
        for (let i = 0; i < IMPORT_GRAPH_LIMITS.reads + 50; i++) files[`src/f${i}.ts`] = 'export const x = 1;';
        const base = treeOf(files);
        await routesReaching({ base }, ['src/target.ts']);
        expect(base.reads.length).toBeLessThanOrEqual(IMPORT_GRAPH_LIMITS.reads + IMPORT_GRAPH_LIMITS.configReads);
    });

    /** A target, 700 files that rank before its importer, and the importer that declares the route. */
    const farImporter = () => {
        const files: Record<string, string> = { 'src/a/target.ts': 'export const t = 1;' };
        for (let i = 0; i < 700; i++) files[`src/a/f${String(i).padStart(3, '0')}.ts`] = 'export const x = 1;';
        files['src/a/zz.ts'] = "import { t } from './target';\napp.get('/far', t);";
        return files;
    };

    it('finds by default a route that only the 701st read reaches, which 400 reads miss', async () => {
        const found = { 'src/a/target.ts': [{ route: 'GET /far', file: 'src/a/zz.ts', hops: 1 }] };
        expect(await routesReaching({ base: treeOf(farImporter(), { batch: true }) }, ['src/a/target.ts'])).toEqual(found);
        expect(await routesReaching({ base: treeOf(farImporter(), { batch: true }), budget: { reads: 400 } }, ['src/a/target.ts'])).toEqual({});
    });

    /** 900 JS/TS files that import one another and declare no route: the walk reads until its budget or the tree runs out. */
    const largeRepo = () => {
        const files: Record<string, string> = { 'package.json': '{ "name": "app" }', 'tsconfig.json': '{ "compilerOptions": { "baseUrl": "." } }', 'src/target.ts': 'export const t = 1;' };
        for (let i = 0; i < 900; i++) files[`src/d${i % 30}/f${i}.ts`] = `import { t } from '../target';\nimport './f${i + 1}';\nexport const x${i} = t;`;
        return files;
    };

    it('reads a large tree in a few dozen calls when the reader reads many files at once', async () => {
        // Measured on this repository of 900 files: 904 reader calls with one call per file (the tree, 2 configs, the
        // changed file, 900 files), 26 with batch reads.
        const single = treeOf(largeRepo());
        const batch = treeOf(largeRepo(), { batch: true });
        await routesReaching({ base: single, budget: { calls: 10_000 } }, ['src/target.ts']);
        await routesReaching({ base: batch }, ['src/target.ts']);
        expect({ single: single.calls, batch: batch.calls, sameFiles: [...batch.reads].sort().join() === [...single.reads].sort().join() }).toEqual({ single: 904, batch: 26, sameFiles: true });
    });

    it('makes no more reader calls than its call bound when the reader reads one file a call', async () => {
        const base = treeOf(largeRepo());
        await routesReaching({ base }, ['src/target.ts']);
        expect(base.calls).toBeLessThanOrEqual(IMPORT_GRAPH_LIMITS.calls);
    });

    it('finds the same routes with batch reads as with one read a file', async () => {
        const files = largeRepo();
        files['src/d7/routes.ts'] = "import { x7 } from './f7';\napp.get('/seven', x7);";
        const one = await routesReaching({ base: treeOf(files), budget: { calls: 10_000 } }, ['src/d7/f7.ts', 'src/target.ts']);
        expect(one['src/d7/f7.ts']).toEqual([{ route: 'GET /seven', file: 'src/d7/routes.ts', hops: 1 }]);
        expect(await routesReaching({ base: treeOf(files, { batch: true }) }, ['src/d7/f7.ts', 'src/target.ts'])).toEqual(one);
    });

    it('lets other work run while it scans what it read', async () => {
        const big = `import './x';\n${'export const filler = [1, 2, 3].map((n) => n * 2);\n'.repeat(2_500)}`;
        const files: Record<string, string> = { 'src/target.ts': 'export const t = 1;' };
        for (let i = 0; i < 80; i++) files[`src/f${i}.ts`] = big;
        let ticks = 0;
        const tick = setInterval(() => ticks++, 0);
        try {
            await routesReaching({ base: treeOf(files, { batch: true }) }, ['src/target.ts']);
        } finally {
            clearInterval(tick);
        }
        // About 10 MB scanned: an in-memory reader answers in microtasks, so only a yield of the scan lets the timer run.
        expect(ticks).toBeGreaterThan(5);
    });

    it('stops reading once it has scanned its byte bound', async () => {
        const big = `export const filler = '${'x'.repeat(IMPORT_GRAPH_LIMITS.fileBytes - 40)}';\n`;
        const files: Record<string, string> = { 'src/target.ts': 'export const t = 1;' };
        const count = Math.ceil(IMPORT_GRAPH_LIMITS.scanBytes / big.length) + 100;
        for (let i = 0; i < count; i++) files[`src/f${i}.ts`] = big;
        const base = treeOf(files, { batch: true });
        await routesReaching({ base }, ['src/target.ts']);
        const scanned = base.reads.filter((p) => p !== 'src/target.ts').length * big.length;
        expect(scanned).toBeLessThan(IMPORT_GRAPH_LIMITS.scanBytes + IMPORT_GRAPH_LIMITS.batch * big.length);
    });

    it('reads no more files than the budget the caller gives', async () => {
        const base = treeOf(farImporter());
        await routesReaching({ base, budget: { reads: 100 } }, ['src/a/target.ts']);
        // The budget's reads, plus the changed file read at the head.
        expect(base.reads.length).toBeLessThanOrEqual(100 + 1);
    });

    it('stops reading at the 15 s cap before the read budget runs out', async () => {
        let now = 1_000_000;
        const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            const base = treeOf(farImporter());
            const read = base.read;
            // One call a file, as many as the reads: the clock, not the call bound, ends the walk.
            // Each read takes 100 ms: the 15 s cap allows about 150 of the 1,000.
            base.read = async (path, max) => ((now += 100), read(path, max));
            expect(await routesReaching({ base }, ['src/a/target.ts'])).toEqual({});
            expect(base.reads.length).toBeLessThan(200);
        } finally {
            clock.mockRestore();
        }
    });

    it('reads only the changed file again for a second round on a commit it already read', async () => {
        const cache = new ImportGraphCache();
        const base = treeOf(NEST);
        await routesReaching({ base, cacheKey: 'repo@sha', cache }, ['src/orders/orders.service.ts']);
        const before = base.reads.length;
        const again = await routesReaching({ base, cacheKey: 'repo@sha', cache }, ['src/orders/orders.service.ts']);
        expect({ reads: base.reads.slice(before), again }).toEqual({ reads: ['src/orders/orders.service.ts'], again: { 'src/orders/orders.service.ts': [{ route: 'GET /orders/:id', file: 'src/orders/orders.controller.ts', hops: 1 }] } });
    });

    it('walks the tree with listings when the reader has no whole-tree call', async () => {
        expect(await routesReaching({ base: treeOf(NEST, { paths: false }) }, ['src/orders/orders.service.ts'])).toEqual({
            'src/orders/orders.service.ts': [{ route: 'GET /orders/:id', file: 'src/orders/orders.controller.ts', hops: 1 }],
        });
    });

    it('answers nothing when the reader refuses to list the tree', async () => {
        const base = treeOf(NEST);
        base.paths = async () => {
            throw new RepoPathError('this Git platform cannot list a commit');
        };
        base.list = base.paths;
        expect(await routesReaching({ base }, ['src/orders/orders.service.ts'])).toEqual({});
    });

    it('reads nothing when no changed file is JavaScript or TypeScript', async () => {
        const base = treeOf({ ...NEST, 'pkg/api/health.go': 'package api' });
        expect({ found: await routesReaching({ base }, ['pkg/api/health.go']), reads: base.reads }).toEqual({ found: {}, reads: [] });
    });
});
