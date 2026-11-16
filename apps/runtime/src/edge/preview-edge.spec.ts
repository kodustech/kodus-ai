import { generateKeyPairSync } from 'crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'http';
import { createServer as createH2Server, type Http2Server, type ServerHttp2Stream } from 'http2';
import { AddressInfo, connect } from 'net';

import { PREVIEW_COOKIE, previewIdFor, previewTicketHash, signPreviewGrant } from '@libs/runtime/contracts/preview';

import { type PreviewRow, sessionHashOf } from '../shared/persistence/preview-store';
import { PreviewEdge } from './preview-edge';
import { InMemoryPreviewStore } from '../shared/persistence/testing';

// The edge against an in-memory store and a fake cell: a plain HTTP/2 server
// reached over a socket the edge attaches as the cell's tunnel (the cell is
// the server, as on a real tunnel). The browser side is plain HTTP with a
// Host header: TLS is the listener's, not the edge's logic.

const DOMAIN = 'preview.example';
const NOW = Date.parse('2026-11-12T12:00:00Z');
const keys = generateKeyPairSync('ed25519');
const ORG = 'org-a';
const HOST = `p-${'a'.repeat(26)}-pr.${DOMAIN}`;
const PREVIEW = previewIdFor(ORG, 'run-1', 'pr');

const row = (over: Partial<PreviewRow> = {}): PreviewRow => ({
    previewId: PREVIEW,
    organizationId: ORG,
    environmentId: 'env-1',
    repositoryId: 'repo-1',
    repositoryFullName: 'acme/shop',
    runId: 'run-1',
    side: 'pr',
    sha: 'a'.repeat(40),
    host: HOST,
    state: 'ready',
    openedBy: 'user-1',
    withoutSecrets: true,
    forkPullRequest: false,
    starts: 1,
    claimId: 'claim-1',
    cellId: 'cell-1',
    target: { service: 'web', port: 3000 },
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 7 * 86_400_000).toISOString(),
    ...over,
});

interface Reply {
    status: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
}

function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: Buffer): Promise<Reply> {
    return new Promise((resolve, reject) => {
        // An empty value means the header is absent.
        const sent = Object.fromEntries(Object.entries({ host: HOST, ...headers }).filter(([, v]) => v !== ''));
        const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: sent }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

describe('preview edge', () => {
    let store: InMemoryPreviewStore;
    let edge: PreviewEdge;
    let server: Server;
    let port: number;
    let cell: Http2Server;
    let now: number;
    const logs: string[] = [];
    const seenByApp: Array<Record<string, unknown>> = [];

    const cellHandler = (stream: ServerHttp2Stream, headers: Record<string, unknown>) => {
        const path = String(headers[':path']);
        if (headers['kodus-preview-id'] !== PREVIEW) {
            stream.respond({ ':status': 404, 'kodus-preview-refused': 'no_route' });
            return stream.end();
        }
        seenByApp.push({ ...headers });
        if (path.startsWith('/large')) {
            stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
            const chunk = Buffer.alloc(64 * 1024, 7);
            let left = 32 * 16; // 32 MiB
            const pump = () => {
                while (left > 0) {
                    left--;
                    if (!stream.write(chunk)) return stream.once('drain', pump);
                }
                stream.end();
            };
            return pump();
        }
        if (path.startsWith('/slow')) {
            return setTimeout(() => {
                stream.respond({ ':status': 200 });
                stream.end('slow');
            }, 300);
        }
        stream.respond({
            ':status': 200,
            'content-type': 'text/html',
            'set-cookie': ['app=1; Path=/; HttpOnly', 'tossed=1; Domain=preview.example; Path=/'],
        });
        stream.end('<p>app</p>');
    };

    const attachCell = () =>
        new Promise<void>((ok) => {
            const sock = connect((cell.address() as AddressInfo).port, '127.0.0.1', () => {
                edge.attachTunnel('cell-1', sock);
                ok();
            });
        });

    const session = async (over: Partial<PreviewRow> = {}) => {
        await store.insertPreview(row(over));
        const cookie = 'c'.repeat(43);
        await store.createSession({ sessionHash: sessionHashOf(cookie), previewId: PREVIEW, organizationId: ORG, userId: 'user-1', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() });
        return `${PREVIEW_COOKIE}=${cookie}`;
    };

    beforeEach(async () => {
        now = NOW;
        logs.length = 0;
        seenByApp.length = 0;
        store = new InMemoryPreviewStore();
        edge = new PreviewEdge({
            store,
            domain: DOMAIN,
            appUrl: 'https://app.kodus.example',
            grantPublicKey: keys.publicKey,
            replicaId: 'edge-1',
            now: () => new Date(now),
            log: (level, msg, fields) => logs.push(JSON.stringify({ level, msg, ...fields })),
        });
        server = createServer(edge.handle);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        port = (server.address() as AddressInfo).port;
        cell = createH2Server();
        cell.on('stream', cellHandler);
        await new Promise<void>((r) => cell.listen(0, '127.0.0.1', r));
    });

    afterEach(async () => {
        edge.close();
        await new Promise((r) => server.close(r));
        await new Promise((r) => cell.close(r));
    });

    const grant = (over: { host?: string; org?: string; at?: number; user?: string } = {}) =>
        signPreviewGrant(keys.privateKey, { host: over.host ?? HOST, userId: over.user ?? 'user-1', organizationId: over.org ?? ORG, previewId: PREVIEW, side: 'pr', now: over.at ?? now }).token;

    /** The prompt's form, posted back to the preview host by the browser: same-origin. */
    const confirm = (g: string, to = '/', headers: Record<string, string> = {}) =>
        get(port, '/__kodus/session', { origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded', ...headers }, 'POST', Buffer.from(new URLSearchParams({ grant: g, to }).toString()));

    it('shows the grant as a prompt naming the repository and pull request, and opens a __Host- HttpOnly SameSite=Lax session on its same-origin POST', async () => {
        await store.insertPreview(row({ prNumber: 12 }));
        const g = grant();
        const prompt = await get(port, `/__kodus/session?grant=${g}&to=/orders?id=7`, { accept: 'text/html' });
        expect(prompt.status).toBe(200);
        expect(prompt.headers['set-cookie']).toBeUndefined();
        const html = prompt.body.toString();
        expect(html).toContain('acme/shop');
        expect(html).toContain('#12');
        expect(html).toContain('method="post"');
        expect(prompt.headers['content-security-policy']).toContain("form-action 'self'");
        expect(prompt.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        expect(prompt.headers['x-frame-options']).toBe('DENY');
        expect(prompt.headers['cache-control']).toBe('no-store');
        const r = await confirm(g, '/orders?id=7');
        expect(r.status).toBe(303);
        expect(r.headers.location).toBe('/orders?id=7');
        expect(r.headers['referrer-policy']).toBe('no-referrer');
        const cookie = String(r.headers['set-cookie']);
        expect(cookie).toMatch(/^__Host-kodus_preview=[A-Za-z0-9_-]{43}; Max-Age=\d+; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
        expect(store.audits.map((a) => a.action)).toEqual(['session_opened']);
    });

    it("a cross-site redirect into another org's preview opens no session: the grant alone sets nothing, and only a same-origin POST does (#4)", async () => {
        await store.insertPreview(row());
        // The attacker's site minted this grant with the attacker's own token and 302s a visitor to it.
        const g = grant({ user: 'attacker' });
        const landed = await get(port, `/__kodus/session?grant=${g}`, { accept: 'text/html', 'sec-fetch-site': 'cross-site' });
        expect(landed.status).not.toBe(303);
        expect(landed.headers['set-cookie']).toBeUndefined();
        // Nor can the attacker's page post the grant for the visitor: another site, a sibling preview host, or an opaque origin.
        const crossSite = await confirm(g, '/', { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' });
        const sibling = await confirm(g, '/', { origin: `https://p-${'b'.repeat(26)}-pr.${DOMAIN}`, 'sec-fetch-site': 'same-site' });
        const opaque = await confirm(g, '/', { origin: 'null', 'sec-fetch-site': '' });
        const noOrigin = await confirm(g, '/', { origin: '', 'sec-fetch-site': '' });
        for (const r of [crossSite, sibling, opaque, noOrigin]) {
            expect(r.status).toBe(404);
            expect(r.headers['set-cookie']).toBeUndefined();
        }
        expect(store.sessions.size).toBe(0);
        expect(store.audits.map((a) => a.action)).not.toContain('session_opened');
    });

    it('a session older than the revalidation window (15 min) is not served: a page load goes back to Kodus for a fresh grant, a script gets 401 (#9)', async () => {
        const cookie = await session();
        await attachCell();
        now += 14 * 60_000;
        expect((await get(port, '/', { cookie, accept: 'text/html' })).status).toBe(200);
        now += 60_000;
        const page = await get(port, '/orders', { cookie, accept: 'text/html' });
        expect(page.status).toBe(303);
        expect(page.headers.location).toBe('https://app.kodus.example/runtime/runs/run-1/preview?side=pr');
        expect(page.headers['cache-control']).toBe('no-store');
        const api = await get(port, '/api/orders', { cookie, accept: 'application/json' });
        expect(api.status).toBe(401);
        expect(seenByApp).toHaveLength(1);
    });

    it("the fresh grant renews the same viewer's session without the prompt, but a grant of another user still prompts (#9)", async () => {
        const cookie = await session();
        now += 16 * 60_000;
        const renewed = await get(port, `/__kodus/session?grant=${grant()}&to=/orders`, { cookie, accept: 'text/html' });
        expect(renewed.status).toBe(303);
        expect(renewed.headers.location).toBe('/orders');
        const fresh = String(renewed.headers['set-cookie']).split(';')[0];
        expect(fresh).not.toBe(cookie);
        await attachCell();
        expect((await get(port, '/', { cookie: fresh, accept: 'text/html' })).status).toBe(200);
        const other = await get(port, `/__kodus/session?grant=${grant({ user: 'user-2' })}`, { cookie, accept: 'text/html' });
        expect(other.status).toBe(200);
        expect(other.headers['set-cookie']).toBeUndefined();
    });

    it('the revalidation window is configurable', async () => {
        const short = new PreviewEdge({ store, domain: DOMAIN, appUrl: 'https://app.kodus.example', grantPublicKey: keys.publicKey, replicaId: 'edge-3', sessionRevalidateMinutes: 1, now: () => new Date(now) });
        const shortServer = createServer(short.handle);
        await new Promise<void>((r) => shortServer.listen(0, '127.0.0.1', r));
        try {
            const cookie = await session({ runId: undefined, side: 'base' });
            now += 61_000;
            const r = await get((shortServer.address() as AddressInfo).port, '/', { cookie, accept: 'text/html' });
            expect(r.status).toBe(303);
            expect(r.headers.location).toBe('https://app.kodus.example/runtime/environments/env-1/preview');
        } finally {
            short.close();
            await new Promise((r) => shortServer.close(r));
        }
    });

    it('a grant is single-use', async () => {
        await store.insertPreview(row());
        const g = grant();
        expect((await confirm(g)).status).toBe(303);
        const again = await confirm(g);
        expect(again.status).toBe(404);
        expect(again.headers['set-cookie']).toBeUndefined();
        expect(store.audits.at(-1)).toMatchObject({ action: 'session_refused', reason: 'grant_replayed' });
    });

    it('a grant expires in 60 seconds', async () => {
        await store.insertPreview(row());
        const g = grant();
        now += 60_000;
        expect((await get(port, `/__kodus/session?grant=${g}`)).status).toBe(404);
        expect(store.audits.at(-1)).toMatchObject({ action: 'session_refused', reason: 'expired' });
    });

    it("refuses another org's grant and a grant for another host, with the same 404", async () => {
        await store.insertPreview(row());
        const other = await get(port, `/__kodus/session?grant=${grant({ org: 'org-b' })}`);
        const wrongHost = await get(port, `/__kodus/session?grant=${grant({ host: `p-${'b'.repeat(26)}-pr.${DOMAIN}` })}`);
        const unknownHost = await get(port, '/', { host: `p-${'z'.repeat(26)}-pr.${DOMAIN}` });
        expect([other.status, wrongHost.status, unknownHost.status]).toEqual([404, 404, 404]);
        expect(other.body.toString()).toBe(unknownHost.body.toString());
        expect(store.audits.map((a) => a.reason)).toEqual(['other_org', 'grant_invalid']);
    });

    it('refuses a request without a session, or with a session of another preview', async () => {
        await store.insertPreview(row());
        await store.createSession({ sessionHash: sessionHashOf('d'.repeat(43)), previewId: previewIdFor(ORG, 'run-2', 'pr'), organizationId: ORG, userId: 'user-1', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() });
        expect((await get(port, '/')).status).toBe(404);
        expect((await get(port, '/', { cookie: `${PREVIEW_COOKIE}=${'d'.repeat(43)}` })).status).toBe(404);
    });

    it('the cookie never reaches the app, nor the viewer IP, nor a client X-Forwarded-For or a spoofed preview id', async () => {
        const cookie = await session();
        await attachCell();
        const r = await get(port, '/page?q=1', {
            cookie: `theme=dark; ${cookie}`,
            'x-forwarded-for': '203.0.113.7',
            'x-real-ip': '203.0.113.7',
            'kodus-preview-id': 'prv_' + 'z'.repeat(26),
            accept: 'text/html',
        });
        expect(r.status).toBe(200);
        expect(r.body.toString()).toBe('<p>app</p>');
        const seen = seenByApp[0];
        expect(seen.cookie).toBe('theme=dark');
        expect(seen['x-forwarded-for']).toBeUndefined();
        expect(seen['x-real-ip']).toBeUndefined();
        expect(seen['kodus-preview-id']).toBe(PREVIEW);
        expect(seen[':path']).toBe('/page?q=1');
        expect(seen['x-forwarded-proto']).toBe('https');
        expect(JSON.stringify(seen)).not.toContain('203.0.113.7');
    });

    it('adds frame-ancestors, HSTS and noindex, and drops an app cookie with a Domain', async () => {
        const cookie = await session();
        await attachCell();
        const r = await get(port, '/', { cookie });
        expect(r.headers['content-security-policy']).toContain("frame-ancestors 'self'");
        expect(r.headers['strict-transport-security']).toContain('max-age=31536000');
        expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
        expect(r.headers['set-cookie']).toEqual(['app=1; Path=/; HttpOnly']);
    });

    it('streams a large response and serves concurrent requests, one slow request not holding the others', async () => {
        const cookie = await session();
        await attachCell();
        const started = Date.now();
        const [large, ...rest] = await Promise.all([get(port, '/large', { cookie }), ...Array.from({ length: 20 }, () => get(port, '/slow', { cookie })), get(port, '/', { cookie })]);
        expect(large.body.length).toBe(32 * 1024 * 1024);
        expect(rest.every((r) => r.status === 200)).toBe(true);
        // 20 slow requests of 300 ms each ran at once, not one after the other.
        expect(Date.now() - started).toBeLessThan(5_000);
    });

    it('a sleeping preview asks to wake and shows the starting page', async () => {
        const cookie = await session({ state: 'sleeping', claimId: undefined, cellId: undefined });
        const r = await get(port, '/', { cookie, accept: 'text/html' });
        expect(r.status).toBe(503);
        expect(r.body.toString()).toContain('waking up');
        expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        expect(store.previews.get(PREVIEW)!.wakeRequestedAt).toBe(new Date(now).toISOString());
        const api = await get(port, '/api/orders', { cookie, accept: 'application/json' });
        expect(api.status).toBe(503);
        expect(api.headers['retry-after']).toBe('5');
    });

    it('records the traffic at most once a minute per preview', async () => {
        const cookie = await session();
        await attachCell();
        await get(port, '/', { cookie });
        await get(port, '/', { cookie });
        expect(store.previews.get(PREVIEW)!.lastActivityAt).toBe(new Date(now).toISOString());
        now += 30_000;
        await get(port, '/', { cookie });
        expect(store.previews.get(PREVIEW)!.lastActivityAt).toBe(new Date(NOW).toISOString());
        now += 31_000;
        await get(port, '/', { cookie });
        expect(store.previews.get(PREVIEW)!.lastActivityAt).toBe(new Date(now).toISOString());
    });

    it('never puts a path, a query, a cookie or a grant in its logs or audit rows', async () => {
        await store.insertPreview(row());
        const g = grant();
        await get(port, `/__kodus/session?grant=${g}&to=/secret-path?token=abc123`);
        const opened = await confirm(g, '/secret-path?token=abc123');
        const cookie = String(opened.headers['set-cookie']).split(';')[0];
        await attachCell();
        await get(port, '/secret-path?token=abc123', { cookie });
        await confirm(g);
        const written = JSON.stringify(logs) + JSON.stringify(store.audits);
        for (const secret of ['secret-path', 'abc123', g, cookie.split('=')[1]]) expect(written).not.toContain(secret);
    });

    it('logs an audit write that fails instead of losing it silently', async () => {
        await store.insertPreview(row());
        jest.spyOn(store, 'audit').mockRejectedValueOnce(new Error('audit table unavailable'));
        const g = 'not-a-grant-token';
        expect((await get(port, `/__kodus/session?grant=${g}&to=/secret-path`)).status).toBe(404);
        const failed = logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === 'preview.audit_unrecorded');
        expect(failed).toEqual([{ level: 'error', msg: 'preview.audit_unrecorded', previewId: PREVIEW, action: 'session_refused', reason: 'grant_invalid', error: 'audit table unavailable' }]);
        for (const secret of [g, 'secret-path']) expect(JSON.stringify(failed)).not.toContain(secret);
    });

    describe('tunnel authorization', () => {
        const ticket = 'T'.repeat(43);
        const peer = { authorized: true, role: 'cell', cn: 'cell-1', serial: '0A1B' };
        beforeEach(async () => {
            store.pins.set('cell-1', 'A1B');
            await store.insertTunnelTicket(previewTicketHash(ticket), 'cell-1', new Date(NOW + 60_000).toISOString());
        });

        it('accepts the pinned certificate of the cell the ticket was issued to, once', async () => {
            expect(await edge.authorizeTunnel(peer, `KodusTunnel ${ticket}`)).toBe('cell-1');
            expect(await edge.authorizeTunnel(peer, `KodusTunnel ${ticket}`)).toBeNull();
        });

        it("refuses another cell's ticket, an unpinned certificate, a non-cell certificate and an expired ticket", async () => {
            expect(await edge.authorizeTunnel({ ...peer, cn: 'cell-2' }, `KodusTunnel ${ticket}`)).toBeNull();
            await store.insertTunnelTicket(previewTicketHash(ticket), 'cell-1', new Date(NOW + 60_000).toISOString());
            expect(await edge.authorizeTunnel({ ...peer, serial: 'FFFF' }, `KodusTunnel ${ticket}`)).toBeNull();
            await store.insertTunnelTicket(previewTicketHash(ticket), 'cell-1', new Date(NOW + 60_000).toISOString());
            expect(await edge.authorizeTunnel({ ...peer, role: 'worker' }, `KodusTunnel ${ticket}`)).toBeNull();
            expect(await edge.authorizeTunnel({ ...peer, authorized: false }, `KodusTunnel ${ticket}`)).toBeNull();
            now += 61_000;
            expect(await edge.authorizeTunnel(peer, `KodusTunnel ${ticket}`)).toBeNull();
        });
    });

    it('a request that lands on a replica without the tunnel goes once to the replica that holds it, which checks the session again', async () => {
        const cookie = await session();
        // This replica (edge-1) holds the cell's tunnel and says where the others reach it.
        const holder = new PreviewEdge({ store, domain: DOMAIN, appUrl: 'https://app.kodus.example', grantPublicKey: keys.publicKey, replicaId: 'edge-1', internalUrl: `http://127.0.0.1:${port}`, now: () => new Date(now) });
        const holderServer = createServer(holder.handle);
        await new Promise<void>((r) => holderServer.listen(0, '127.0.0.1', r));
        const holderPort = (holderServer.address() as AddressInfo).port;
        const other = new PreviewEdge({ store, domain: DOMAIN, appUrl: 'https://app.kodus.example', grantPublicKey: keys.publicKey, replicaId: 'edge-2', now: () => new Date(now) });
        const otherServer = createServer(other.handle);
        await new Promise<void>((r) => otherServer.listen(0, '127.0.0.1', r));
        const otherPort = (otherServer.address() as AddressInfo).port;
        try {
            await new Promise<void>((ok) => {
                const sock = connect((cell.address() as AddressInfo).port, '127.0.0.1', () => {
                    holder.attachTunnel('cell-1', sock);
                    ok();
                });
            });
            await store.holdTunnel('cell-1', 'edge-1', new Date(now).toISOString(), `http://127.0.0.1:${holderPort}`);
            const r = await get(otherPort, '/orders', { cookie, accept: 'text/html' });
            expect(r.status).toBe(200);
            expect(r.body.toString()).toBe('<p>app</p>');
            expect(seenByApp.at(-1)).not.toHaveProperty('x-kodus-preview-forwarded');
            // Without a session the holder refuses it, as it would directly; a forwarded request is never forwarded again.
            expect((await get(otherPort, '/orders')).status).toBe(404);
            await store.holdTunnel('cell-1', 'edge-3', new Date(now).toISOString(), `http://127.0.0.1:${otherPort}`);
            const loop = await get(otherPort, '/orders', { cookie, 'x-kodus-preview-forwarded': 'edge-9' });
            expect(loop.status).toBe(503);
        } finally {
            holder.close();
            other.close();
            await new Promise((r) => holderServer.close(r));
            await new Promise((r) => otherServer.close(r));
        }
    });
});
