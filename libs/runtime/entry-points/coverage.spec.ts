import { coveredEntryPoint, routeShapeOf, requestMatchesEntryPoint } from './coverage';

describe('entry-point coverage from the observer log (S-32)', () => {
    it('normalizes a concrete path like the cell observer', () => {
        expect(routeShapeOf('/orders/42')).toBe('/orders/:id');
        expect(routeShapeOf('/users/3f2a1c9e-1b2c-4d5e-8f90-123456789abc/cart?x=1')).toBe('/users/:id/cart');
        expect(routeShapeOf('/files/deadbeefdeadbeef00')).toBe('/files/:id');
        expect(routeShapeOf('/users/alice')).toBe('/users/alice');
    });

    it('matches a declared route segment by segment; a param takes any one segment', () => {
        expect(requestMatchesEntryPoint('GET /orders/:orderId', { method: 'GET', route: '/orders/:id' })).toBe(true);
        expect(requestMatchesEntryPoint('GET /users/{name}', { method: 'get', route: '/users/alice' })).toBe(true);
        expect(requestMatchesEntryPoint('GET /blog/[slug]', { method: 'GET', route: '/blog/hello' })).toBe(true);
        expect(requestMatchesEntryPoint('POST /orders', { method: 'GET', route: '/orders' })).toBe(false);
        expect(requestMatchesEntryPoint('GET /orders/:id', { method: 'GET', route: '/orders' })).toBe(false);
        expect(requestMatchesEntryPoint('GET /orders/:id', { method: 'GET', route: '/orders/:id/items' })).toBe(false);
        expect(requestMatchesEntryPoint('GET /orders', { method: 'GET', route: '/health' })).toBe(false);
        expect(requestMatchesEntryPoint('worker:src/jobs/sync.ts', { method: 'GET', route: '/' })).toBe(false);
    });

    it('matches a route served below a mount it does not declare (demo-immich, demo-directus)', () => {
        // Nest @Controller('server') under setGlobalPrefix('api'); an Express router mounted at /server.
        expect(requestMatchesEntryPoint('GET /server/about', { method: 'GET', route: '/api/server/about' })).toBe(true);
        expect(requestMatchesEntryPoint('GET /info', { method: 'GET', route: '/server/info' })).toBe(true);
        expect(requestMatchesEntryPoint('GET /users/:id', { method: 'GET', route: '/api/v1/users/:id' })).toBe(true);
        // At most two leading segments, the tail must match whole, and a declaration without a literal never matches by its tail.
        expect(requestMatchesEntryPoint('GET /info', { method: 'GET', route: '/a/b/c/info' })).toBe(false);
        expect(requestMatchesEntryPoint('GET /info', { method: 'GET', route: '/server/info/extra' })).toBe(false);
        expect(requestMatchesEntryPoint('GET /', { method: 'GET', route: '/api/anything' })).toBe(false);
        expect(requestMatchesEntryPoint('GET /:id', { method: 'GET', route: '/server/:id' })).toBe(false);
        expect(requestMatchesEntryPoint('POST /info', { method: 'GET', route: '/server/info' })).toBe(false);
    });

    const ids = ['POST /orders', 'GET /orders/:id'];
    const sent = (method: string, route: string) => [{ method, route }];

    it('a probe labelled POST /orders that only sent GET /health covers nothing', () => {
        expect(coveredEntryPoint('POST /orders', ids, { base: sent('GET', '/health'), pr: sent('GET', '/health') })).toBe('unmapped');
    });

    it('keeps the label when both sides back it, and corrects it when the log shows another diff route', () => {
        expect(coveredEntryPoint('POST /orders', ids, { base: sent('POST', '/orders'), pr: sent('POST', '/orders') })).toBe('POST /orders');
        expect(coveredEntryPoint('POST /orders', ids, { base: sent('GET', '/orders/:id'), pr: sent('GET', '/orders/:id') })).toBe('GET /orders/:id');
    });

    it('needs the request on both sides', () => {
        expect(coveredEntryPoint('POST /orders', ids, { base: sent('POST', '/orders'), pr: [] })).toBe('unmapped');
        expect(coveredEntryPoint('POST /orders', ids, { base: [], pr: sent('POST', '/orders') })).toBe('unmapped');
    });
});
