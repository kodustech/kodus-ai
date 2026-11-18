import { ChildProcess, execFileSync, spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { generateKeyPairSync } from 'crypto';

import { PREVIEW_COOKIE, previewIdFor, previewTicketHash } from '@libs/runtime/contracts/preview';

import { normalizedSerial, sessionHashOf } from '../shared/persistence/preview-store';
import { type EdgeListeners, startPreviewEdge } from './edge-app';
import { InMemoryPreviewStore } from '../shared/persistence/testing';
import { goCellEnabled } from '../testing/go-cell';

// The Node edge against the real Go tunnel (apps/runtime-cell/internal/preview,
// through test/preview-tunnel-probe): the cell dials the edge's tunnel
// listener with a client certificate from the cell CA and a one-time ticket,
// serves stdlib HTTP/2 over the WebSocket, and proxies to its app through the
// observer's preview proxy. Proves a request, a streamed 64 MiB response, 50
// concurrent streams, the cookie and the viewer's headers never reaching the
// app, a Domain cookie dropped, and an id the cell was never given refused.
// Needs go and openssl; opt-in (RUNTIME_IT_GO_CELL=1, testing/go-cell.ts), run by
// the integration project (jest.integration.config.ts).

const ROOT = resolve(__dirname, '../../../..');
const enabled = goCellEnabled();

const DOMAIN = 'preview.example';
const HOST = `p-${'k'.repeat(26)}-pr.${DOMAIN}`;
const OTHER_HOST = `p-${'m'.repeat(26)}-pr.${DOMAIN}`;
const ORG = 'org-a';
const PREVIEW = previewIdFor(ORG, 'run-1', 'pr');
const OTHER = previewIdFor(ORG, 'run-2', 'pr');
const TICKET = 'Q'.repeat(43);

function openssl(dir: string, ...args: string[]) {
    execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
}

interface Reply {
    status: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
}

(enabled ? describe : describe.skip)('preview edge ↔ Go cell tunnel', () => {
    jest.setTimeout(180_000);
    let dir: string;
    let listeners: EdgeListeners;
    let probe: ChildProcess | undefined;
    let probeErr = '';
    const store = new InMemoryPreviewStore();
    const cookie = 'z'.repeat(43);

    const get = (path: string, host = HOST, headers: Record<string, string> = {}): Promise<Reply> =>
        new Promise((ok, ko) => {
            const port = (listeners.browser.address() as AddressInfo).port;
            const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host, cookie: `${PREVIEW_COOKIE}=${cookie}`, ...headers } }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => ok({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
            });
            req.on('error', ko);
            req.end();
        });

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'kr-preview-tunnel-'));
        // The cell CA, a cell certificate (OU=cell, CN=cell-1) and the edge's tunnel certificate for 127.0.0.1.
        openssl(dir, 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=kodus-test-cell-ca');
        writeFileSync(join(dir, 'client.ext'), 'extendedKeyUsage=clientAuth\n');
        writeFileSync(join(dir, 'server.ext'), 'extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
        for (const [name, subj, ext] of [
            ['cell', '/OU=cell/CN=cell-1', 'client.ext'],
            ['edge', '/CN=127.0.0.1', 'server.ext'],
        ]) {
            openssl(dir, 'req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', subj);
            openssl(dir, 'x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', '1', '-extfile', ext);
        }
        const serial = execFileSync('openssl', ['x509', '-in', join(dir, 'cell.pem'), '-noout', '-serial'], { encoding: 'utf8' }).trim().split('=')[1];
        store.pins.set('cell-1', normalizedSerial(serial));
        execFileSync('go', ['build', '-o', join(dir, 'probe'), './test/preview-tunnel-probe'], { cwd: join(ROOT, 'apps/runtime-cell'), stdio: 'inherit' });

        listeners = await startPreviewEdge(
            {
                databaseUrl: 'unused',
                replicaId: 'edge-it',
                domain: DOMAIN,
                appUrl: 'https://app.kodus.example',
                grantPublicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(),
                port: 0,
                tlsUpstream: true,
                tunnelPort: 0,
                tunnelTls: { cert: readFileSync(join(dir, 'edge.pem'), 'utf8'), key: readFileSync(join(dir, 'edge.key'), 'utf8'), cellCa: readFileSync(join(dir, 'ca.pem'), 'utf8') },
                productionImage: false,
            },
            () => undefined,
            store,
        );
        const at = new Date().toISOString();
        const later = new Date(Date.now() + 3_600_000).toISOString();
        for (const [previewId, host, runId] of [
            [PREVIEW, HOST, 'run-1'],
            [OTHER, OTHER_HOST, 'run-2'],
        ]) {
            await store.insertPreview({ previewId, organizationId: ORG, environmentId: 'env-1', repositoryId: 'repo-1', repositoryFullName: 'acme/shop', runId, side: 'pr', sha: 'c'.repeat(40), host, state: 'ready', openedBy: 'user-1', withoutSecrets: true, forkPullRequest: false, starts: 1, claimId: `claim-${runId}`, cellId: 'cell-1', target: { service: 'web', port: 1 }, createdAt: at, updatedAt: at, expiresAt: later });
        }
        await store.createSession({ sessionHash: sessionHashOf(cookie), previewId: PREVIEW, organizationId: ORG, userId: 'user-1', createdAt: at, expiresAt: later });
        await store.createSession({ sessionHash: sessionHashOf('y'.repeat(43)), previewId: OTHER, organizationId: ORG, userId: 'user-1', createdAt: at, expiresAt: later });
        await store.insertTunnelTicket(previewTicketHash(TICKET), 'cell-1', later);

        const tunnelPort = (listeners.tunnel.address() as AddressInfo).port;
        probe = spawn(join(dir, 'probe'), [
            '-url', `wss://127.0.0.1:${tunnelPort}/v1/cells/tunnel`,
            '-cert', join(dir, 'cell.pem'),
            '-key', join(dir, 'cell.key'),
            '-ca', join(dir, 'ca.pem'),
            '-server-name', '127.0.0.1',
            '-ticket', TICKET,
            '-preview-id', PREVIEW,
        ]);
        probe.stderr!.on('data', (d: Buffer) => (probeErr += d.toString()));
        await new Promise<void>((ok, ko) => {
            const timer = setTimeout(() => ko(new Error(`probe not ready: ${probeErr.slice(-2000)}`)), 60_000);
            probe!.stdout!.on('data', (d: Buffer) => {
                if (d.toString().includes('"ready":true')) {
                    clearTimeout(timer);
                    ok();
                }
            });
            probe!.once('exit', (code) => ko(new Error(`probe exited ${code}: ${probeErr.slice(-2000)}`)));
        });
        for (let i = 0; i < 50 && !listeners.edge.tunnels.has('cell-1'); i++) await new Promise((r) => setTimeout(r, 100));
    });

    afterAll(async () => {
        probe?.kill('SIGTERM');
        await listeners?.close();
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('the ticket was spent and the tunnel is held by this edge', () => {
        expect(listeners.edge.tunnels.has('cell-1')).toBe(true);
        expect(store.tickets.size).toBe(0);
        expect(store.tunnels.get('cell-1')?.replica).toBe('edge-it');
    });

    it('serves a request through the tunnel', async () => {
        const r = await get('/small');
        expect(r.status).toBe(200);
        expect(r.body.toString()).toBe('hello');
        expect(r.headers['strict-transport-security']).toContain('max-age=31536000');
    });

    it('streams a 64 MiB response', async () => {
        const r = await get('/large?mb=64');
        expect(r.status).toBe(200);
        expect(r.body.length).toBe(64 * 1024 * 1024);
    });

    it('serves 50 concurrent streams at once', async () => {
        const t0 = Date.now();
        const all = await Promise.all([get('/large?mb=16'), ...Array.from({ length: 50 }, () => get('/slow')), get('/small')]);
        expect(all.every((r) => r.status === 200)).toBe(true);
        expect(all.filter((r) => r.body.toString() === 'slow')).toHaveLength(50);
        // 50 × 500 ms one after the other would be 25 s.
        expect(Date.now() - t0).toBeLessThan(8_000);
    });

    it('the app gets neither the preview cookie nor the viewer address, and the browser no Domain cookie', async () => {
        const r = await get('/echo-headers?x=1', HOST, { cookie: `theme=dark; ${PREVIEW_COOKIE}=${cookie}`, 'x-forwarded-for': '198.51.100.4' });
        const seen = JSON.parse(r.body.toString()) as { path: string; headers: Record<string, string[]> };
        expect(seen.path).toBe('/echo-headers?x=1');
        expect(seen.headers.Cookie).toEqual(['theme=dark']);
        expect(JSON.stringify(seen.headers)).not.toContain('198.51.100.4');
        expect(seen.headers['Kodus-Preview-Id']).toBeUndefined();
        expect(seen.headers['X-Forwarded-Proto']).toEqual(['https']);
        const cookies = await get('/set-cookie');
        expect(cookies.headers['set-cookie']).toEqual(['app_sid=1; Path=/; HttpOnly']);
    });

    it('a preview id the cell was never routed is refused by the cell', async () => {
        const r = await get('/small', OTHER_HOST, { cookie: `${PREVIEW_COOKIE}=${'y'.repeat(43)}`, accept: 'application/json' });
        expect(r.status).toBe(503);
        expect(r.body.toString()).not.toContain('hello');
    });
});
