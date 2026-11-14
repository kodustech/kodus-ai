import { requestMatchesEntryPoint } from './coverage';
import { changedLines, DIFF_TRUNCATED_MARKER_PATH, extractEntryPoints } from './extract';

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

    it('a change above the first route reaches every route in the file', () => {
        const content = ["import x from 'y'", "router.get('/a', h)", "router.post('/b', h)"].join('\n');
        expect(ids([{ path: 'src/r.ts', content, patch: '@@ -1,1 +1,1 @@\n+import x from "z"' }]).sort()).toEqual([
            'http_route|GET /a',
            'http_route|POST /b',
        ]);
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

    it('a change in a helper below the handlers reaches every route of the controller, not only the nearest one', () => {
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
        expect(ids([{ path: 'src/orders.controller.ts', content, patch: '@@ -9,1 +9,1 @@\n-  return 0;\n+  return 1;' }]).sort()).toEqual([
            'http_route|GET /orders/:id',
            'http_route|POST /orders',
        ]);
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
});
