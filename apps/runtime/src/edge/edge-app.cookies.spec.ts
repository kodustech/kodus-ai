import { generateKeyPairSync } from 'crypto';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'http';
import { AddressInfo, connect } from 'net';

import { PREVIEW_COOKIE } from '@libs/runtime/contracts/preview';

import { InMemoryPreviewStore } from '../shared/persistence/testing';
import { BROWSER_MAX_HEADER_BYTES, createBrowserListener } from './edge-app';
import { CLEARING_MAX_BYTES, previewCookieClearingFor } from './cookie-clearing';
import { PreviewEdge } from './preview-edge';

// S1-WEB-01: until the preview domain is on the Public Suffix List, a page of
// any preview can toss cookies onto the whole preview domain, at any path. A
// browser that carries enough of them to the edge must get them expired by the
// edge, at the path they were set on, whatever their size, or every org's
// previews stay dead in that browser.

const DOMAIN = 'preview.example';
const HOST = `p-${'a'.repeat(26)}-pr.${DOMAIN}`;

function send(port: number, path: string, cookie: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host: HOST, cookie, accept: 'text/html' }, maxHeaderSize: 1024 * 1024 }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** Writes a request whose headers pass Node's client limit, and reads the raw answer. */
function sendRaw(port: number, cookieBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => {
            socket.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\nCookie: big=${'x'.repeat(cookieBytes)}\r\n\r\n`);
        });
        let answer = '';
        socket.on('data', (c) => (answer += c.toString()));
        socket.on('end', () => resolve(answer));
        socket.on('error', (e: NodeJS.ErrnoException) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve(answer) : reject(e)));
    });
}

const bomb = (count: number, size: number) => Array.from({ length: count }, (_, i) => `b${i}=${'x'.repeat(size)}`).join('; ');

describe('preview edge cookie bomb', () => {
    let edge: PreviewEdge;
    let server: Server;
    let port: number;

    beforeEach(async () => {
        edge = new PreviewEdge({
            store: new InMemoryPreviewStore(),
            domain: DOMAIN,
            appUrl: 'https://app.kodus.example',
            grantPublicKey: generateKeyPairSync('ed25519').publicKey,
            replicaId: 'edge-1',
            log: () => undefined,
        });
        server = createBrowserListener(edge);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        port = (server.address() as AddressInfo).port;
    });

    afterEach(async () => {
        edge.close();
        await new Promise((r) => server.close(r));
    });

    it('expires cookies past 32 KiB with its own answer, not a bare 431 from Node', async () => {
        // 180 cookies of 4 KiB: what a browser keeps for one site at most.
        const r = await send(port, '/', bomb(180, 4_000));
        expect(r.status).toBe(431);
        const cleared = r.headers['set-cookie'] as string[];
        expect(cleared).toContain(`b0=; Max-Age=0; Path=/; Domain=${DOMAIN}; Secure`);
        expect(cleared).toContain('b0=; Max-Age=0; Path=/; Secure');
        expect(r.body).toContain('Reload');
    });

    it('expires a cookie at the path it may have been set on', async () => {
        const r = await send(port, '/api/orders/7', bomb(4, 3_000));
        expect(r.status).toBe(431);
        const cleared = r.headers['set-cookie'] as string[];
        for (const path of ['/', '/api', '/api/', '/api/orders', '/api/orders/', '/api/orders/7'])
            expect(cleared).toContain(`b0=; Max-Age=0; Path=${path}; Domain=${DOMAIN}; Secure`);
        expect(cleared.join('\n')).not.toContain(PREVIEW_COOKIE);
    });

    it('answers a header past its hard cap with its own page, closing the connection', async () => {
        const answer = await sendRaw(port, BROWSER_MAX_HEADER_BYTES + 1024);
        expect(answer.startsWith('HTTP/1.1 431')).toBe(true);
        expect(answer.toLowerCase()).toContain('connection: close');
        expect(answer).toContain('clear this site');
    });
});

describe('previewCookieClearingFor', () => {
    it('clears the largest cookies first and stays within its byte budget', () => {
        const header = [bomb(170, 100), `huge=${'y'.repeat(4_000)}`, `${PREVIEW_COOKIE}=${'c'.repeat(43)}`].join('; ');
        const cleared = previewCookieClearingFor(header, DOMAIN, '/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t');
        expect(cleared[0].startsWith('huge=;')).toBe(true);
        expect(cleared.reduce((n, c) => n + c.length, 0)).toBeLessThanOrEqual(CLEARING_MAX_BYTES);
        // A name is expired at every path or not at all, so each answer makes whole progress.
        const names = new Set(cleared.map((c) => c.slice(0, c.indexOf('='))));
        const perName = cleared.length / names.size;
        expect(Number.isInteger(perName)).toBe(true);
        expect(cleared.join('\n')).not.toContain(PREVIEW_COOKIE);
    });

    it('never echoes a name or a path that is not a cookie token', () => {
        const cleared = previewCookieClearingFor('a b=1; ok=2; x\u0001y=3', DOMAIN, '/p;q/r');
        expect(cleared.every((c) => c.startsWith('ok=;'))).toBe(true);
        expect(cleared.join('\n')).not.toContain(';q');
    });
});
