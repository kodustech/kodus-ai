/**
 * A guarded call to a server that speaks HTTP/2 must come back whole: headers
 * and a decoded body. undici's connector offers h2 over ALPN by default, and
 * Node's built-in fetch, through `Dispatcher1Wrapper`, drops every header of an
 * h2 response: no content-type, no pagination, and a body still compressed.
 * gitlab.com and most LLM APIs answer h2, so every GitLab read came back as a
 * Blob (`files.map is not a function`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createSecureServer, type Http2SecureServer } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as tls from 'node:tls';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createGatewayDispatcher } from './gateway-address-guard';

jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: true },
}));

const PAYLOAD = [{ id: 1 }, { id: 2 }];

let server: Http2SecureServer;
let port: number;
let certDir: string;
const sessions = new Set<import('node:http2').ServerHttp2Session>();
const savedCAs = tls.getCACertificates('default');

beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'gateway-h2-'));
    execFileSync(
        'openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '1',
            '-subj',
            '/CN=localhost',
            '-addext',
            'subjectAltName=DNS:localhost',
            '-keyout',
            join(certDir, 'key.pem'),
            '-out',
            join(certDir, 'cert.pem'),
        ],
        { stdio: 'ignore' },
    );
    server = createSecureServer(
        {
            key: readFileSync(join(certDir, 'key.pem')),
            cert: readFileSync(join(certDir, 'cert.pem')),
            allowHTTP1: true,
        },
        (_req, res) => {
            res.setHeader('content-type', 'application/json');
            res.setHeader('content-encoding', 'gzip');
            res.setHeader('x-next-page', '2');
            res.end(gzipSync(JSON.stringify(PAYLOAD)));
        },
    );
    server.on('session', (session) => {
        sessions.add(session);
        session.on('close', () => sessions.delete(session));
    });
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as AddressInfo).port;
    // Trust the test certificate without touching the guard's TLS options.
    tls.setDefaultCACertificates([
        ...savedCAs,
        readFileSync(join(certDir, 'cert.pem'), 'utf8'),
    ]);
});

afterAll(async () => {
    tls.setDefaultCACertificates(savedCAs);
    sessions.forEach((session) => session.destroy());
    await new Promise((resolve) => server.close(resolve));
    rmSync(certDir, { recursive: true, force: true });
});

it('keeps the headers and decodes the body of a server that offers h2', async () => {
    const dispatcher = createGatewayDispatcher({ refuses: () => false });

    const response = await fetch(new Request(`https://localhost:${port}/`), {
        dispatcher,
    } as RequestInit);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-next-page')).toBe('2');
    expect(await response.json()).toEqual(PAYLOAD);
});
