import type { IncomingMessage } from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import type { Duplex } from 'stream';
import type { TLSSocket } from 'tls';

import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocketServer } from 'ws';

import { MAX_FRAME_BYTES } from '@libs/runtime/protocol';

import { RUNTIME_CONFIG, RuntimeConfig } from '../shared/config';
import { CellHub } from './cell-hub';
import { peerCert } from './gateway/peer-cert';
import type { CellCredential } from './hub-types';

export { peerCert } from './gateway/peer-cert';

const h = (s: string) => createHash('sha256').update(s).digest();
const REVOCATION_TICK_MS = 5_000;

/**
 * Accepts the cells' outbound WebSocket at /cells (ADR-051): no compression,
 * 1 MiB frames, and only over mTLS with a cell certificate (ADR-054). The
 * public listener asks for a client certificate without requiring one
 * (/cells/register has none yet); secureConnection drops a socket whose
 * certificate does not chain, is revoked or is not the pinned serial, and
 * every route then demands the certificate it needs.
 */
@Injectable()
export class CellGatewayService implements OnModuleInit, OnApplicationShutdown {
    private readonly logger = new Logger('CellGateway');
    private wss?: WebSocketServer;
    private revocations?: NodeJS.Timeout;

    constructor(
        private readonly adapterHost: HttpAdapterHost,
        @Inject(CellHub) private readonly hub: CellHub,
        @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    ) {}

    /** Plaintext test mode only: a shared per-cell token (never with TLS). */
    private testOnlyToken(cellId: string | undefined, auth: string): CellCredential | null {
        const entry = cellId ? this.config.testOnlyPlaintext?.cellTokens[cellId] : undefined;
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!entry || !token || !timingSafeEqual(h(entry.token), h(token))) return null;
        return { cellId: cellId!, owner: entry.owner, orgId: entry.orgId };
    }

    private async authenticate(req: IncomingMessage): Promise<CellCredential | null> {
        const peer = peerCert(req.socket);
        if (peer) return peer.presented ? this.hub.authenticateCell(peer) : null;
        return this.testOnlyToken(req.headers['x-kodus-cell-id'] as string | undefined, req.headers.authorization ?? '');
    }

    onModuleInit() {
        const server = this.adapterHost.httpAdapter.getHttpServer();
        this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
        server.on('secureConnection', (tls: TLSSocket) => {
            const peer = peerCert(tls);
            if (peer && !this.hub.handshakeAllowed(peer)) {
                this.logger.warn({ msg: 'tls.peer_refused', cn: peer.cn ?? null, serial: peer.serial ?? null, why: 'untrusted, revoked or not the pinned certificate' });
                tls.destroy();
            }
        });
        server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
            const url = new URL(req.url ?? '/', 'http://hub');
            if (url.pathname !== '/cells') return socket.destroy();
            void this.authenticate(req)
                .then((cred) => {
                    if (!cred) {
                        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                        return socket.destroy();
                    }
                    this.accept(req, socket, head, cred);
                })
                .catch((e) => {
                    this.hub.hubMetrics.backgroundError('ws_upgrade');
                    this.logger.warn({ msg: 'ws.upgrade_failed', error: (e as Error).message });
                    socket.destroy();
                });
        });
        this.revocations = setInterval(
            () =>
                void this.hub.enforceRevocations().catch((e) => {
                    this.hub.hubMetrics.backgroundError('revocation');
                    this.logger.error({ msg: 'revocation.enforce_failed', error: (e as Error).message });
                }),
            REVOCATION_TICK_MS,
        );
        this.revocations.unref?.();
    }

    private accept(req: IncomingMessage, socket: Duplex, head: Buffer, cred: CellCredential) {
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
            const handlers = this.hub.attach(ws, cred);
            this.logger.log({ msg: 'cell.connected', cellId: cred.cellId, owner: cred.owner });
            ws.on('message', (data, isBinary) => void handlers.onMessage(isBinary ? (data as Buffer) : data.toString()));
            ws.on('close', () => {
                this.logger.log({ msg: 'cell.disconnected', cellId: cred.cellId });
                void handlers.onClose();
            });
            ws.on('error', () => ws.terminate());
        });
    }

    onApplicationShutdown() {
        if (this.revocations) clearInterval(this.revocations);
        for (const c of this.wss?.clients ?? []) c.close(1012, 'hub restarting');
        this.wss?.close();
    }
}
