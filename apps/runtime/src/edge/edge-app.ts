import { createPublicKey } from 'crypto';
import { createServer as httpServer, type IncomingMessage, type Server } from 'http';
import { createServer as httpsServer } from 'https';
import type { Duplex } from 'stream';
import type { TLSSocket } from 'tls';

import { Pool } from 'pg';
import { createWebSocketStream, WebSocketServer } from 'ws';

import { PREVIEW_TUNNEL_PATH } from '@libs/runtime/contracts/preview';

import type { PreviewEdgeConfig } from '../shared/config';
import { peerIdentity } from '../shared/identity/tls-identity';
import { PgPreviewStore, type PreviewStore } from '../shared/persistence/preview-store';
import { type EdgeLog, PreviewEdge, type TunnelPeer } from './preview-edge';

// The runtime-preview-edge process: the browser listener and the cells'
// tunnel listener (docs/runtime/preview-urls.md §4). Separate listeners: the
// browser's TLS may end at a load balancer, a cell's mTLS never does.

/** The tunnel WebSocket carries a byte stream: no frame limit beyond HTTP/2's own, no compression (CRIME-class leaks, CPU). */
const TUNNEL_MAX_PAYLOAD = 16 * 1024 * 1024;

export function tunnelPeerOf(socket: unknown): TunnelPeer {
    const tls = socket as TLSSocket;
    if (!tls || typeof tls.getPeerCertificate !== 'function') return { authorized: false };
    const c = tls.getPeerCertificate();
    if (!c || !Object.keys(c).length) return { authorized: false };
    const id = peerIdentity(c.subject as unknown as Record<string, string | string[] | undefined>);
    return { authorized: tls.authorized === true, serial: c.serialNumber, ...id };
}

/** Accepts the cells' tunnels on `server` (its 'upgrade' event): authorized ones become HTTP/2 sessions of the edge. */
export function serveTunnels(server: Server, edge: PreviewEdge, log: EdgeLog, peerOf: (socket: unknown) => TunnelPeer = tunnelPeerOf) {
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: TUNNEL_MAX_PAYLOAD });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (new URL(req.url ?? '/', 'http://edge').pathname !== PREVIEW_TUNNEL_PATH) return socket.destroy();
        void edge
            .authorizeTunnel(peerOf(req.socket), req.headers.authorization)
            .then((cellId) => {
                if (!cellId) {
                    log('warn', 'preview.tunnel.refused', {});
                    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                    return socket.destroy();
                }
                wss.handleUpgrade(req, socket, head, (ws) => {
                    const stream = createWebSocketStream(ws);
                    stream.on('error', () => ws.terminate());
                    edge.attachTunnel(cellId, stream);
                });
            })
            .catch((e) => {
                log('warn', 'preview.tunnel.upgrade_failed', { error: (e as Error).message.slice(0, 200) });
                socket.destroy();
            });
    });
    return wss;
}

/**
 * Request headers the browser listener reads (Node answers 431 itself past
 * 16 KiB by default). Until the preview domain is on the Public Suffix List,
 * a page of any preview can toss cookies onto the whole preview domain
 * (S1-WEB-01), up to what a browser keeps for one site: about 180 cookies of
 * 4 KiB. The edge must read such a header to expire them; past this hard cap
 * it can only ask the viewer to clear the site's data (headerOverflowAnswer).
 */
export const BROWSER_MAX_HEADER_BYTES = 1024 * 1024;

const OVERFLOW_PAGE =
    '<!doctype html><meta charset="utf-8"><title>Too many cookies</title>' +
    '<p>This browser carries more cookies to Kodus previews than the preview server accepts. ' +
    'In the browser settings, clear this site&rsquo;s cookies for the preview domain, then reload the page.</p>';

/**
 * Node's clientError, answered by the edge: a header past the hard cap gets a
 * page saying how to recover, instead of a bare 431. Any other parse error
 * gets the 400 Node would send. The connection always closes.
 */
export function headerOverflowAnswer(err: NodeJS.ErrnoException, socket: Duplex) {
    if (err.code === 'ECONNRESET' || !socket.writable) return socket.destroy();
    const body = err.code === 'HPE_HEADER_OVERFLOW' ? OVERFLOW_PAGE : '';
    const status = err.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
    socket.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
}

/** The browser listener: the edge's handler behind Node's HTTP(S) server. */
export function createBrowserListener(edge: PreviewEdge, tls?: { cert: string | Buffer; key: string | Buffer }): Server {
    const maxHeaderSize = BROWSER_MAX_HEADER_BYTES;
    const browser = tls
        ? httpsServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2', maxHeaderSize }, edge.handle)
        : httpServer({ maxHeaderSize }, edge.handle);
    browser.on('clientError', headerOverflowAnswer);
    // Slow clients cannot hold sockets forever (nor a large header buffer); a long download is still fine (no total timeout on the response).
    browser.headersTimeout = 20_000;
    browser.requestTimeout = 0;
    return browser;
}

export interface EdgeListeners {
    edge: PreviewEdge;
    browser: Server;
    tunnel: Server;
    close(): Promise<void>;
}

export async function startPreviewEdge(config: PreviewEdgeConfig, log: EdgeLog, store?: PreviewStore): Promise<EdgeListeners> {
    const grantPublicKey = createPublicKey(config.grantPublicKey);
    if (grantPublicKey.asymmetricKeyType !== 'ed25519') throw new Error('RUNTIME_PREVIEW_GRANT_PUBLIC_KEY must be an Ed25519 public key');
    const pool = store ? undefined : new Pool({ connectionString: config.databaseUrl, max: 10 });
    const edge = new PreviewEdge({ store: store ?? new PgPreviewStore(pool!), domain: config.domain, appUrl: config.appUrl, grantPublicKey, replicaId: config.replicaId, ...(config.internalUrl ? { internalUrl: config.internalUrl } : {}), ...(config.sessionRevalidateMinutes ? { sessionRevalidateMinutes: config.sessionRevalidateMinutes } : {}), log });
    const browser = createBrowserListener(edge, config.tls);
    const tunnel = httpsServer({
        cert: config.tunnelTls.cert,
        key: config.tunnelTls.key,
        ca: config.tunnelTls.cellCa,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
    });
    tunnel.on('request', (_req, res) => {
        res.writeHead(404);
        res.end();
    });
    const wss = serveTunnels(tunnel, edge, log);
    await Promise.all([
        new Promise<void>((ok, ko) => browser.once('error', ko).listen(config.port, ok)),
        new Promise<void>((ok, ko) => tunnel.once('error', ko).listen(config.tunnelPort, ok)),
    ]);
    edge.startHeartbeat();
    return {
        edge,
        browser,
        tunnel,
        close: async () => {
            edge.close();
            wss.close();
            await Promise.all([new Promise((r) => browser.close(r)), new Promise((r) => tunnel.close(r))]);
            // Pool end on shutdown: a connection that fails to close goes with the process.
            await pool?.end().catch(() => undefined);
        },
    };
}
