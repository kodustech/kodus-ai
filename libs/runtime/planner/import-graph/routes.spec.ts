import { routesOf as routesIn } from './routes';

/** A tree with the markers of a Next app at the root and under apps/web, and of a Remix app. */
const TREE = new Set(['next.config.js', 'apps/web/next.config.mjs', 'app/root.tsx']);
const routesOf = (path: string, text: string, files: ReadonlySet<string> = TREE) => routesIn(path, text, files);

describe('routes a file declares', () => {
    it('maps a Next app-router page to the GET of its route', () => {
        expect(routesOf('apps/web/src/app/(dashboard)/orders/[orderId]/page.tsx', 'export default function Page() { return null; }')).toEqual(['GET /orders/:orderId']);
    });

    it('maps a Next app-router layout to the GET of the route it wraps', () => {
        expect(routesOf('app/settings/layout.tsx', 'export default function L({ children }) { return children; }')).toEqual(['GET /settings']);
    });

    it('maps a Next pages-router page to the GET of its route', () => {
        expect(routesOf('src/pages/blog/[slug].tsx', 'export default function Post() { return null; }')).toEqual(['GET /blog/:slug']);
    });

    it('maps no page route for a pages directory of an app that is not Next', () => {
        expect(routesOf('packages/front/src/pages/auth/PasswordReset.tsx', 'export const PasswordReset = () => null;', new Set(['packages/front/vite.config.ts']))).toEqual([]);
    });

    it('maps no route for a file under app/routes of an app that is not Remix', () => {
        expect(routesOf('admin/app/routes/users.tsx', 'export default function U() {}', new Set(['admin/vite.config.ts']))).toEqual([]);
    });

    it('maps no route for the pages-router _app and _document wrappers', () => {
        expect(routesOf('pages/_app.tsx', 'export default function App() {}')).toEqual([]);
        expect(routesOf('pages/_document.tsx', 'export default function Doc() {}')).toEqual([]);
    });

    it('keeps the Next route-handler methods the entry-point extractor reads', () => {
        expect(routesOf('app/api/orders/route.ts', 'export async function POST(req) { return Response.json({}); }')).toEqual(['POST /api/orders']);
    });

    it('maps a Remix flat route with a param and an action to the GET and POST of its path', () => {
        const text = 'export async function loader() {}\nexport async function action() {}\nexport default function R() {}';
        expect(routesOf('app/routes/users.$userId.edit.tsx', text)).toEqual(['GET /users/:userId/edit', 'POST /users/:userId/edit']);
    });

    it('maps the Remix index route and drops pathless layout segments', () => {
        expect(routesOf('app/routes/_index.tsx', 'export default function I() {}')).toEqual(['GET /']);
        expect(routesOf('app/routes/_auth.login.tsx', 'export default function L() {}')).toEqual(['GET /login']);
    });

    it('keeps the routes of a Nest controller', () => {
        const text = "@Controller('orders')\nexport class OrdersController {\n  @Get(':id')\n  one() {}\n  @Post()\n  create() {}\n}";
        expect(routesOf('src/orders/orders.controller.ts', text)).toEqual(['GET /orders/:id', 'POST /orders']);
    });

    it('maps a Nest GraphQL resolver with a query or mutation to POST /graphql', () => {
        const text = "@Resolver(() => Workspace)\nexport class WorkspaceResolver {\n  @Mutation(() => Workspace)\n  update() {}\n}";
        expect(routesOf('server/workspace.resolver.ts', text)).toEqual(['POST /graphql']);
    });

    it('maps a Fastify route object to its method and url', () => {
        const text = "fastify.route({\n  method: 'PUT',\n  url: '/items/:id',\n  handler: async () => ({}),\n});";
        expect(routesOf('src/items.ts', text)).toEqual(['PUT /items/:id']);
    });

    it('maps a route call on a router-named receiver with a literal path as the generic fallback', () => {
        expect(routesOf('src/http/billing.ts', "export function mount(r) {\n  r.post('/billing/charge', charge);\n}")).toEqual(['POST /billing/charge']);
    });

    it('finds no route in a service that sends requests through an HTTP client', () => {
        expect(routesOf('src/bitbucket.service.ts', "const r = await axiosClient.get('/projects?limit=1');\nawait this.http.post('/repos', body);")).toEqual([]);
    });

    it('finds no route in a helper whose get calls take a key, not a path', () => {
        expect(routesOf('src/lib/cache.ts', "export const read = (m) => m.get('user') ?? params.get('id');")).toEqual([]);
    });

    it('finds a route in a file with a line too long to scan only on its other lines', () => {
        const text = `const blob = '${'x'.repeat(5_000)}';\nrouter.get('/health', ok);`;
        expect(routesOf('src/routes.ts', text)).toEqual(['GET /health']);
    });

    it('answers within a second for a file built to make backtracking patterns hang', () => {
        const hostile = `@Controller('${'a'.repeat(60_000)}\n` + '@Controller(' + ' '.repeat(60_000) + '\n' + "router.get('/".repeat(5_000);
        const started = Date.now();
        routesOf('src/hostile.controller.ts', hostile);
        expect(Date.now() - started).toBeLessThan(1_000);
    });
});
