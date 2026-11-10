import { randomUUID } from 'crypto';

import { Envelope, MAX_FRAME_BYTES, MessageBody, MessageType, PROTOCOL_VERSION } from '@libs/runtime/protocol';
import type { RuntimeMetrics } from '@libs/runtime/telemetry';

import type { CellSessionRepository } from '../hub-store';
import { CellCredential, CellUnavailableError, HubLog, HubMetrics, ReadyOutcome, SocketLike, StepOutcome } from '../hub-types';

// The live WebSocket connections of this replica, one per cell, and the
// request/answer plumbing on them. A connection that closes resolves every
// wait on it (pending acks reject, claim readiness and steps become lost);
// nothing is ever resent on another connection.

const ACK_TIMEOUT_MS = 5_000;
/** Protective per-connection ceilings, not measured throughput targets. */
export const CELL_CONNECTION_LIMITS = { bufferedBytes: 4 * 1024 * 1024, pendingRequests: 128, inFlightSteps: 256 } as const;

type PendingAck = { resolve: (e: Envelope) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type PendingStep = { claimId: string; resolve: (o: StepOutcome) => void; timer: NodeJS.Timeout };
type PendingReady = { resolve: (o: ReadyOutcome) => void; timer: NodeJS.Timeout };

export class CellConnection {
    readonly sessionEpoch = randomUUID();
    helloDone = false;
    closed = false;
    readonly pending = new Map<string, PendingAck>();
    readonly steps = new Map<string, PendingStep>();
    /**
     * The id of each step frame sent, to its stepId: the cell answers the frame
     * itself (ack: accepted; nack: refused) before the step.result, and a
     * refusal must end the step now instead of at its timeout.
     */
    readonly stepFrames = new Map<string, string>();
    /** claim.acquire rounds waiting for claim.ready / claim.failed, by claimId. */
    readonly readies = new Map<string, PendingReady>();
    constructor(
        readonly socket: SocketLike,
        readonly cred: CellCredential,
    ) {}
}

export class CellConnectionRegistry {
    private readonly connections = new Map<string, CellConnection>();

    constructor(
        private readonly sessions: Pick<CellSessionRepository, 'disconnect'>,
        private readonly metrics: RuntimeMetrics,
        private readonly hubMetrics: HubMetrics,
        private readonly replicaId: string,
        private readonly log: HubLog,
    ) {}

    envelope<T extends MessageType>(cellId: string, type: T, body: MessageBody<T>, extra: { re?: string; claimId?: string } = {}): Envelope<T> {
        return { v: PROTOCOL_VERSION, id: randomUUID(), cellId, type, body, ...extra } as Envelope<T>;
    }

    /** An overloaded connection becomes lost; frames are never silently dropped or resent. */
    send(conn: CellConnection, env: Envelope): boolean {
        if (conn.closed) return false;
        try {
            const payload = JSON.stringify(env);
            const bytes = Buffer.byteLength(payload);
            const buffered = conn.socket.bufferedAmount ?? 0;
            const reason = bytes > MAX_FRAME_BYTES ? 'frame'
                : !Number.isFinite(buffered) || buffered < 0 || buffered + bytes > CELL_CONNECTION_LIMITS.bufferedBytes ? 'buffer'
                : conn.pending.size > CELL_CONNECTION_LIMITS.pendingRequests ? 'requests'
                : conn.steps.size > CELL_CONNECTION_LIMITS.inFlightSteps ? 'steps'
                : undefined;
            if (reason) {
                this.hubMetrics.connectionOverload(reason);
                this.log('warn', 'cell.overloaded', { cellId: conn.cred.cellId, reason, bufferedBytes: buffered, frameBytes: bytes, pendingRequests: conn.pending.size, inFlightSteps: conn.steps.size });
                this.drop(conn, 'connection overloaded');
                // close() can retain the sender's queue until its handshake times out.
                conn.socket.terminate?.();
                return false;
            }
            conn.socket.send(payload);
            return true;
        } catch (e) {
            this.log('warn', 'cell.send_failed', { cellId: conn.cred.cellId, error: (e as Error).message });
            this.drop(conn, 'send failed');
            return false;
        }
    }

    /** Refuses a frame. A frame that did not decode has no id to answer: it is counted and logged, not answered. */
    nack(conn: CellConnection, re: string | undefined, code: string, message: string) {
        this.metrics.recordProtocolViolation({ cellId: conn.cred.cellId, code });
        if (!re) {
            this.log('warn', 'cell.frame_refused', { cellId: conn.cred.cellId, code, detail: message.slice(0, 200) });
            return;
        }
        this.send(conn, this.envelope(conn.cred.cellId, 'nack', { code, message: message.slice(0, 1_024) }, { re }));
    }

    ack(conn: CellConnection, re: string, body: MessageBody<'ack'> = {}) {
        this.send(conn, this.envelope(conn.cred.cellId, 'ack', body, { re }));
    }

    /** Registers a new connection; a previous one of the same cell is dropped. */
    add(socket: SocketLike, cred: CellCredential): CellConnection {
        const previous = this.connections.get(cred.cellId);
        if (previous) this.drop(previous, 'replaced by a new connection');
        const conn = new CellConnection(socket, cred);
        this.connections.set(cred.cellId, conn);
        return conn;
    }

    get(cellId: string): CellConnection | undefined {
        const c = this.connections.get(cellId);
        return c && !c.closed && c.helloDone ? c : undefined;
    }

    /** The live connection of a cell on this replica, or CellUnavailableError. */
    require(cellId: string): CellConnection {
        const c = this.get(cellId);
        if (!c) throw new CellUnavailableError(cellId);
        return c;
    }

    isCurrent(conn: CellConnection) {
        return this.connections.get(conn.cred.cellId) === conn;
    }

    heldCellIds(): string[] {
        return [...this.connections.keys()];
    }

    /** A request that the cell answers with ack, nack or blocked (by `re`). */
    request<T extends MessageType>(cellId: string, type: T, body: MessageBody<T>, claimId?: string): Promise<Envelope> {
        const conn = this.require(cellId);
        const env = this.envelope(cellId, type, body, { claimId });
        return new Promise<Envelope>((resolve, reject) => {
            const timer = setTimeout(() => {
                conn.pending.delete(env.id);
                reject(new CellUnavailableError(`${cellId}: no ack in ${ACK_TIMEOUT_MS} ms`));
            }, ACK_TIMEOUT_MS);
            conn.pending.set(env.id, { resolve, reject, timer });
            if (!this.send(conn, env)) {
                clearTimeout(timer);
                conn.pending.delete(env.id);
                reject(new CellUnavailableError(`${cellId}: connection closed`));
            }
        });
    }

    /** Resolves the request a reply (`re`) answers; false when none waits for it. */
    answer(conn: CellConnection, re: string | undefined, reply: Envelope): boolean {
        const p = re ? conn.pending.get(re) : undefined;
        if (!p) return false;
        conn.pending.delete(re!);
        clearTimeout(p.timer);
        p.resolve(reply);
        return true;
    }

    /** Closes a connection and resolves every wait on it. */
    drop(conn: CellConnection, reason: string) {
        if (conn.closed) return;
        conn.closed = true;
        for (const [id, p] of conn.pending) {
            clearTimeout(p.timer);
            p.reject(new CellUnavailableError(`${conn.cred.cellId}: ${reason}`));
            conn.pending.delete(id);
        }
        for (const [claimId, r] of conn.readies) {
            clearTimeout(r.timer);
            r.resolve({ type: 'lost', why: 'disconnected' });
            conn.readies.delete(claimId);
        }
        for (const [stepId, s] of conn.steps) {
            clearTimeout(s.timer);
            s.resolve({ type: 'lost' });
            conn.steps.delete(stepId);
        }
        conn.stepFrames.clear();
        try {
            conn.socket.close(1012, reason);
        } catch {
            /* already closed */
        }
    }

    /** The connection closed: the session ends on this replica (only if still ours) and every wait resolves. */
    async closed(conn: CellConnection) {
        if (this.isCurrent(conn)) {
            this.connections.delete(conn.cred.cellId);
            await this.sessions.disconnect(conn.cred.cellId, this.replicaId, conn.sessionEpoch).catch((e) => {
                this.hubMetrics.backgroundError('session_disconnect');
                this.log('warn', 'cell.disconnect_unrecorded', { cellId: conn.cred.cellId, error: (e as Error).message });
            });
            if (conn.helloDone) this.metrics.cellConnectedDelta(-1, { owner: conn.cred.owner });
        }
        this.drop(conn, 'connection closed');
    }

    /** Removes a cell's connection right away (revocation). */
    async evict(cellId: string, reason: string) {
        const conn = this.connections.get(cellId);
        if (!conn) return;
        this.send(conn, this.envelope(cellId, 'cell.revoked', { reason }));
        await this.closed(conn);
    }
}
