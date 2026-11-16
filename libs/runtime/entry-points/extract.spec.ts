import { requestMatchesEntryPoint } from './coverage';
import { changedLines, DIFF_TRUNCATED_MARKER_PATH, extractEntryPoints, routesServedBy } from './extract';

const ids = (files: Parameters<typeof extractEntryPoints>[0]) =>
    extractEntryPoints(files).map((e) => `${e.kind}|${e.id}`);

describe('changedLines', () => {
    it('reads added lines from a unified diff', () => {
        expect(changedLines('@@ -10,2 +10,3 @@\n a\n+b\n c')).toEqual([11]);
    });
});

describe('extractEntryPoints', () => {
    it('maps a NestJS handler to its route, with the controller prefix', () => {
        const content = [
            "@Controller('orders')",
            'export class OrdersController {',
            "    @Get(':id')",
            '    find() { return 1; }',
            '    @Post()',
            '    create() {',
            '        return 2;',
            '    }',
            '}',
        ].join('\n');
        const patch = '@@ -6,2 +6,2 @@\n     create() {\n-        return 1;\n+        return 2;';
        expect(ids([{ path: 'src/orders/orders.controller.ts', content, patch }])).toEqual(['http_route|POST /orders']);
    });

    it('maps an Express route call', () => {
        const content = ["router.get('/health', ok)", "router.post('/orders', (req, res) => {", '  res.send(1)', '})'].join('\n');
        const patch = '@@ -3,1 +3,1 @@\n-  res.send(0)\n+  res.send(1)';
        expect(ids([{ path: 'src/routes.ts', content, patch }])).toEqual(['http_route|POST /orders']);
    });

    it('maps a Fastify route call', () => {
        const content = "fastify.get('/products/:id', handler)";
        expect(ids([{ path: 'src/server.ts', content, patch: '@@ -1,1 +1,1 @@\n+x' }])).toEqual(['http_route|GET /products/:id']);
    });

    it('a change above the first route that runs at load (a side-effect import) reaches every route in the file', () => {
        const content = ["import 'z'", "router.get('/a', h)", "router.post('/b', h)"].join('\n');
        const patch = "@@ -1,1 +1,1 @@\n-import 'y'\n+import 'z'";
        expect(ids([{ path: 'src/r.ts', content, patch }]).sort()).toEqual(['http_route|GET /a', 'http_route|POST /b']);
    });

    it('a changed import reaches only the handlers that use what it imports', () => {
        const content = ["import { a } from 'z'", "router.get('/a', (req, res) => res.send(a()))", "router.post('/b', (req, res) => res.send(1))"].join('\n');
        const patch = "@@ -1,1 +1,1 @@\n-import { a } from 'y'\n+import { a } from 'z'";
        expect(ids([{ path: 'src/r.ts', content, patch }])).toEqual(['http_route|GET /a']);
    });

    it('maps a Next.js app route by its exported methods', () => {
        const content = 'export async function GET() {}\nexport async function POST() {}';
        expect(ids([{ path: 'app/(shop)/api/orders/[id]/route.ts', content }]).sort()).toEqual([
            'http_route|GET /api/orders/:id',
            'http_route|POST /api/orders/:id',
        ]);
    });

    it('maps a Next.js pages api route', () => {
        expect(ids([{ path: 'src/pages/api/users/index.ts', content: 'export default h' }])).toEqual(['http_route|ALL /api/users']);
    });

    it('a Next route without exported methods and a catch-all route are matched by what the observer sent', () => {
        const eps = extractEntryPoints([
            { path: 'app/api/users/route.ts', content: 'export default 1' },
            { path: 'app/api/files/[...slug]/route.ts', content: 'export async function GET() {}' },
        ]).map((e) => e.id);
        expect(eps).toEqual(['ALL /api/users', 'GET /api/files/*slug']);
        expect(requestMatchesEntryPoint('ALL /api/users', { method: 'GET', route: '/api/users' })).toBe(true);
        expect(requestMatchesEntryPoint('GET /api/files/*slug', { method: 'GET', route: '/api/files/a/b' })).toBe(true);
        expect(requestMatchesEntryPoint('GET /api/files/*slug', { method: 'GET', route: '/api/files' })).toBe(false);
    });

    it('a change in a helper below the handlers reaches the handlers that call it, not the nearest one', () => {
        const content = [
            "@Controller('orders')",
            'class C {',
            "  @Get(':id')",
            '  get() { return helper(); }',
            '  @Post()',
            '  create() {}',
            '}',
            'function helper() {',
            '  return 1;',
            '}',
        ].join('\n');
        expect(ids([{ path: 'src/orders.controller.ts', content, patch: '@@ -9,1 +9,1 @@\n-  return 0;\n+  return 1;' }])).toEqual(['http_route|GET /orders/:id']);
    });

    it('the marker of a truncated diff becomes an entry point no probe can settle', () => {
        expect(ids([{ path: DIFF_TRUNCATED_MARKER_PATH, patch: '' }])).toEqual(['unmapped|unmapped:diff-truncated']);
    });

    it('lockfile, Dockerfile, compose and CI are dependency surface', () => {
        expect(
            ids([
                { path: 'pnpm-lock.yaml' },
                { path: 'Dockerfile.api' },
                { path: 'docker-compose.dev.yml' },
                { path: '.github/workflows/ci.yml' },
            ]).every((id) => id.startsWith('dependency_surface|')),
        ).toBe(true);
    });

    it('a utility with no route is unmapped, and tests and docs are ignored', () => {
        expect(
            ids([
                { path: 'src/lib/money.ts', content: 'export const add = (a, b) => a + b' },
                { path: 'src/lib/money.spec.ts' },
                { path: 'README.md' },
            ]),
        ).toEqual(['unmapped|unmapped:src/lib/money.ts']);
    });

    it('a recipe file whose PR copy the Run never boots is no entry point: S-19 reports it, not the dependency note', () => {
        const recipe = ['.kodus/workspace.yaml', '.kodus/Dockerfile.kody'];
        expect(extractEntryPoints([{ path: '.kodus/workspace.yaml', patch: '@@' }, { path: '.kodus/Dockerfile.kody', patch: '@@' }], { recipe })).toEqual([]);
    });

    it('any other root .kodus/ file is a build file the PR side boots with: dependency surface (kr-grafana #7)', () => {
        const recipe = ['.kodus/workspace.yaml'];
        const files = [
            { path: '.kodus/compose.yaml', patch: '@@' },
            { path: '.kodus/Dockerfile.backend', patch: '@@' },
            { path: '.kodus/seed.sql', patch: '@@' },
            { path: '.kodus/README.md', patch: '@@' },
        ];
        expect(extractEntryPoints(files, { recipe }).map((e) => `${e.kind}:${e.match.file}`)).toEqual([
            'dependency_surface:.kodus/compose.yaml',
            'dependency_surface:.kodus/Dockerfile.backend',
            'dependency_surface:.kodus/seed.sql',
        ]);
        // No recipe in the claims: the PR's own workspace file boots, so it is build surface too.
        expect(extractEntryPoints([{ path: '.kodus/workspace.yaml', patch: '@@' }]).map((e) => e.kind)).toEqual(['dependency_surface']);
        expect(extractEntryPoints([{ path: 'deploy/compose.yaml', patch: '@@' }]).map((e) => e.kind)).toEqual(['dependency_surface']);
    });

    it('a pull request cannot stall the extractor with a crafted file: it answers at once and the file stays unmapped', () => {
        const patch = '@@ -1,1 +1,1 @@\n+x';
        const spaces = ' '.repeat(100_000);
        const files = [
            // Whitespace runs where the decorator patterns backtrack, inside the size bound.
            { path: 'src/a.controller.ts', content: `@Controller(${'\n'.repeat(60_000)}\n@Get(${spaces.slice(0, 399)}\n`, patch },
            { path: 'src/b.controller.ts', content: `@Controller('b')\n@Get(${spaces}\n`, patch },
            // Past the size bound: not read at all.
            { path: 'src/c.controller.ts', content: `@Controller('c')\n@Get('x')\nfind() {}\n${'/'.repeat(1_000_000)}`, patch },
        ];
        const started = Date.now();
        expect(ids(files)).toEqual([
            'unmapped|unmapped:src/a.controller.ts',
            'unmapped|unmapped:src/b.controller.ts',
            'unmapped|unmapped:src/c.controller.ts',
        ]);
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('a file declaring more routes than the extractor maps stays unmapped instead of listing them all', () => {
        const routes = Array.from({ length: 200 }, (_, i) => `router.get('/r${i}', h);`).join('\n');
        expect(ids([{ path: 'src/routes.ts', content: routes, patch: '@@ -1,1 +1,1 @@\n+x' }])).toEqual(['unmapped|unmapped:src/routes.ts']);
    });

    describe('routes the diff adds', () => {
        const added = (files: Parameters<typeof extractEntryPoints>[0]) =>
            extractEntryPoints(files).filter((e) => e.added).map((e) => e.id).sort();

        it('marks an Express route whose declaration line is added (kr-shop#4 server.js)', () => {
            const content = [
                "app.get('/orders', list)",
                "app.post('/orders', async (req, res) => {",
                '    res.status(201).json(rows[0]);',
                '});',
                '',
                "const BILLING_URL = process.env.BILLING_URL || 'http://billing:4000';",
                '',
                "app.post('/orders/preview', async (req, res) => {",
                "    res.json({ total: 20 });",
                '});',
            ].join('\n');
            const patch = [
                '@@ -4,0 +5,6 @@',
                '+',
                "+const BILLING_URL = process.env.BILLING_URL || 'http://billing:4000';",
                '+',
                "+app.post('/orders/preview', async (req, res) => {",
                "+    res.json({ total: 20 });",
                '+});',
            ].join('\n');
            const files = [{ path: 'server.js', content, patch }];
            // The constant and the blank lines reach no other handler: only the route the diff adds.
            expect(ids(files)).toEqual(['http_route|POST /orders/preview']);
            expect(added(files)).toEqual(['POST /orders/preview']);
        });

        it('marks a plain node:http route whose method and path check is added (kr-shop-billing#3 server.js)', () => {
            const content = [
                'const server = http.createServer(async (req, res) => {',
                "    const path = new URL(req.url, 'http://localhost').pathname;",
                "    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });",
                "    if (req.method === 'POST' && path === '/invoices/preview') {",
                '        return send(res, 200, { total: 1 });',
                '    }',
                "    if (req.method === 'GET' && path === '/partner/echo') {",
                "        const r = await fetch('https://partner.example/headers');",
                '        return send(res, 200, { status: r.status });',
                '    }',
                "    send(res, 404, { error: 'not found' });",
                '});',
            ].join('\n');
            const patch = [
                '@@ -6,0 +7,4 @@',
                "+    if (req.method === 'GET' && path === '/partner/echo') {",
                "+        const r = await fetch('https://partner.example/headers');",
                '+        return send(res, 200, { status: r.status });',
                '+    }',
            ].join('\n');
            const files = [{ path: 'server.js', content, patch }];
            expect(ids(files)).toEqual(['http_route|GET /partner/echo']);
            expect(added(files)).toEqual(['GET /partner/echo']);
            // A change inside an existing branch reaches that route, not added.
            const inside = '@@ -5,1 +5,1 @@\n-        return send(res, 200, { total: 0 });\n+        return send(res, 200, { total: 1 });';
            expect(ids([{ path: 'server.js', content, patch: inside }])).toEqual(['http_route|POST /invoices/preview']);
            expect(added([{ path: 'server.js', content, patch: inside }])).toEqual([]);
            // The path first and the method second is the same route.
            expect(ids([{ path: 'h.js', content: "if (url === '/x' && req.method === 'DELETE') {\n}", patch: '@@ -0,0 +1,1 @@\n+x' }])).toEqual(['http_route|DELETE /x']);
        });

        it('a route the diff moves to another file is not added', () => {
            const files = [
                { path: 'src/old.ts', patch: "@@ -1,1 +0,0 @@\n-router.post('/orders/preview', h)" },
                { path: 'src/new.ts', content: "router.post('/orders/preview', h)", patch: "@@ -0,0 +1,1 @@\n+router.post('/orders/preview', h)" },
            ];
            expect(ids(files)).toContain('http_route|POST /orders/preview');
            expect(added(files)).toEqual([]);
        });

        it('a route whose handler changes is not added', () => {
            const content = ["router.post('/orders', (req, res) => {", '  res.send(1)', '})'].join('\n');
            expect(added([{ path: 'src/routes.ts', content, patch: '@@ -2,1 +2,1 @@\n-  res.send(0)\n+  res.send(1)' }])).toEqual([]);
        });

        it('marks a Nest handler whose decorator is added', () => {
            const content = ["@Controller('orders')", 'export class C {', '    @Get()', '    list() {}', "    @Post('preview')", '    preview() {}', '}'].join('\n');
            const patch = "@@ -4,0 +5,2 @@\n+    @Post('preview')\n+    preview() {}";
            expect(added([{ path: 'src/orders.controller.ts', content, patch }])).toEqual(['POST /orders/preview']);
        });

        it('marks every method of a new Next.js route file', () => {
            const content = 'export async function GET() {}\nexport async function POST() {}';
            const patch = '@@ -0,0 +1,2 @@\n+export async function GET() {}\n+export async function POST() {}';
            expect(added([{ path: 'app/api/preview/route.ts', content, patch }])).toEqual(['GET /api/preview', 'POST /api/preview']);
        });
    });
});

describe('extractEntryPoints: only what the diff reaches (planner-eval.md P5, P6)', () => {
    const controller = [
        "@Controller('server')",
        'export class ServerController {',
        "  @Get('ping')",
        '  ping() { return 1; }',
        "  @Get('about')",
        '  about() { return 2; }',
        '}',
    ];

    it('a comment after the controller class maps no route (kr-immich#1)', () => {
        const content = [...controller, '', '// no behavior change'].join('\n');
        const patch = '@@ -6,2 +6,4 @@\n   about() { return 2; }\n }\n+\n+// no behavior change';
        expect(ids([{ path: 'src/server.controller.ts', content, patch }])).toEqual([]);
    });

    it('a comment at the end of a Next route file maps no route (kr-calcom#1)', () => {
        const content = 'export const GET = handler;\n\n// note';
        const patch = '@@ -1,1 +1,3 @@\n export const GET = handler;\n+\n+// note';
        expect(ids([{ path: 'app/api/version/route.ts', content, patch }])).toEqual([]);
    });

    it('a comment next to a code change still maps the changed handler', () => {
        const content = ['// a', ...controller.slice(0, 5), '  about() { return 3; }', '}'].join('\n');
        const patch = '@@ -1,7 +1,8 @@\n+// a\n' + controller.slice(0, 5).map((l) => ` ${l}`).join('\n') + '\n-  about() { return 2; }\n+  about() { return 3; }\n }';
        expect(ids([{ path: 'src/server.controller.ts', content, patch }])).toEqual(['http_route|GET /server/about']);
    });

    it('a line in a Nest handler whose route decorator is followed by another decorator with an object maps that handler (kr-immich#2)', () => {
        const content = [
            "@Controller('server')",
            'export class ServerController {',
            "  @Get('ping')",
            '  @Endpoint({',
            "    summary: 'Ping',",
            '  })',
            '  pingServer() {',
            '    const pong = this.service.ping();',
            '    return pong;',
            '  }',
            '',
            "  @Get('version')",
            '  getVersion() {',
            '    return 1;',
            '  }',
            '}',
        ].join('\n');
        const patch = '@@ -7,3 +7,4 @@\n   pingServer() {\n-    return this.service.ping();\n+    const pong = this.service.ping();\n+    return pong;\n   }';
        expect(ids([{ path: 'src/server.controller.ts', content, patch }])).toEqual(['http_route|GET /server/ping']);
    });

    it('a constant only one handler reads maps that handler (kr-shop#6)', () => {
        const content = [
            "const URL = 'http://billing:4000';",
            "app.get('/health', (req, res) => res.send('ok'));",
            "app.post('/orders/preview', async (req, res) => {",
            '  res.json(await fetch(URL));',
            '});',
        ].join('\n');
        const patch = "@@ -1,1 +1,1 @@\n-const URL = 'http://billing:3000';\n+const URL = 'http://billing:4000';";
        expect(ids([{ path: 'server.js', content, patch }])).toEqual(['http_route|POST /orders/preview']);
    });

    it('a helper reached through another helper maps the handler at the end of the chain', () => {
        const content = [
            'function inner() { return 2; }',
            'function outer() { return inner(); }',
            "app.get('/a', (req, res) => res.send(outer()));",
            "app.get('/b', (req, res) => res.send(1));",
        ].join('\n');
        const patch = '@@ -1,1 +1,1 @@\n-function inner() { return 1; }\n+function inner() { return 2; }';
        expect(ids([{ path: 'server.js', content, patch }])).toEqual(['http_route|GET /a']);
    });

    it('a helper a middleware uses reaches every route', () => {
        const content = ['function auth(req, res, next) { next(); }', 'app.use(auth);', "app.get('/a', h);", "app.get('/b', h);"].join('\n');
        const patch = '@@ -1,1 +1,1 @@\n-function auth(req, res, next) { return next(); }\n+function auth(req, res, next) { next(); }';
        expect(ids([{ path: 'server.js', content, patch }]).sort()).toEqual(['http_route|GET /a', 'http_route|GET /b']);
    });

    it('an exported helper no handler of the file uses is unmapped: its routes are elsewhere', () => {
        const content = ['export function total(x) { return x * 2; }', "router.get('/a', (req, res) => res.send(1));"].join('\n');
        const patch = '@@ -1,1 +1,1 @@\n-export function total(x) { return x; }\n+export function total(x) { return x * 2; }';
        expect(ids([{ path: 'src/r.ts', content, patch }])).toEqual(['unmapped|unmapped:src/r.ts']);
    });

    it('a route call with its path on the next line is a route (kr-directus#1)', () => {
        const content = ['router.get(', "\t'/info',", '\tasyncHandler(async (req, res) => {', '\t\tconst data = 2;', '\t}),', ');', "router.get('/health', h);"].join('\n');
        const patch = '@@ -4,1 +4,1 @@\n-\t\tconst data = 1;\n+\t\tconst data = 2;';
        expect(ids([{ path: 'api/src/controllers/server.ts', content, patch }])).toEqual(['http_route|GET /info']);
    });

    it('a Next App Router page is GET of its folder, groups and slots left out of the URL (kr-nextjs#2)', () => {
        const content = 'export default function Home() {\n  return <p>Production configuration</p>;\n}';
        const patch = '@@ -2,1 +2,1 @@\n-  return <p>Production-ready configuration</p>;\n+  return <p>Production configuration</p>;';
        expect(ids([{ path: 'examples/with-docker/app/page.tsx', content, patch }])).toEqual(['http_route|GET /']);
        expect(ids([{ path: 'app/(shop)/@modal/orders/[id]/page.tsx', content, patch }])).toEqual(['http_route|GET /orders/:id']);
        expect(ids([{ path: 'app/docs/[[...slug]]/page.tsx', content, patch }])).toEqual(['http_route|GET /docs/*slug']);
    });

    it('a private folder or an intercepting route is no route of its own', () => {
        const content = 'export default function P() {\n  return 2;\n}';
        const patch = '@@ -2,1 +2,1 @@\n-  return 1;\n+  return 2;';
        expect(ids([{ path: 'app/_lib/page.tsx', content, patch }])).toEqual(['unmapped|unmapped:app/_lib/page.tsx']);
        expect(ids([{ path: 'app/feed/(..)photo/page.tsx', content, patch }])).toEqual(['unmapped|unmapped:app/feed/(..)photo/page.tsx']);
    });

    it('a Remix 3 route map: strings serve any method, helpers one, route() nests under its prefix (kr-remix#1)', () => {
        const content = [
            "import { get, post, route, form, resources } from 'remix/routes'",
            'export const routes = route({',
            "  home: '/',",
            "  books: { index: '/books', show: '/books/:slug' },",
            "  cart: route('cart', {",
            "    index: get('/'),",
            "    add: post('/api/add'),",
            '  }),',
            "  contact: form('contact'),",
            "  orders: resources('orders', { only: ['index', 'show'], param: 'orderId' }),",
            '})',
        ].join('\n');
        expect(routesServedBy({ path: 'app/routes.ts', content }).sort()).toEqual(
            ['ALL /', 'ALL /books', 'ALL /books/:slug', 'GET /cart', 'POST /cart/api/add', 'GET /contact', 'POST /contact', 'GET /orders', 'GET /orders/:orderId'].sort(),
        );
        const patch = "@@ -7,1 +7,1 @@\n-    add: post('/api/put'),\n+    add: post('/api/add'),";
        expect(ids([{ path: 'app/routes.ts', content, patch }])).toEqual(['http_route|POST /cart/api/add']);
    });

    it('a React Router v7 route config: route(), index(), layout() and prefix()', () => {
        const content = [
            "import { type RouteConfig, index, layout, prefix, route } from '@react-router/dev/routes';",
            'export default [',
            "  index('./home.tsx'),",
            "  route('about', './about.tsx'),",
            "  layout('./auth/layout.tsx', [route('login', './auth/login.tsx')]),",
            "  ...prefix('concerts', [index('./concerts/home.tsx'), route(':city', './concerts/city.tsx')]),",
            '] satisfies RouteConfig;',
        ].join('\n');
        expect(routesServedBy({ path: 'app/routes.ts', content }).sort()).toEqual(['ALL /', 'ALL /about', 'ALL /concerts', 'ALL /concerts/:city', 'ALL /login'].sort());
    });
});
