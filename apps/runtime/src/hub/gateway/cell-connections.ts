import { randomUUID } from 'crypto';

import { Envelope, MAX_FRAME_BYTES, MessageBody, MessageType, PROTOCOL_VERSION } from '@libs/runtime/protocol';
import { activeTraceparent, type RuntimeMetrics } from '@libs/runtime/telemetry';

import type { CellSessionRepository } from '../hub-store';
import { CellCapacityView, CellCredential, CellUnavailableError, HubLog, HubMetrics, ReadyOutcome, SocketLike, StepOutcome } from '../hub-types';

// The live WebSocket connections of this replica, one per cell, and the
// request/answer plumbing on them. A connection that closes resolves every
// wait on it (pending acks reject, claim readiness and steps become lost);
// nothing is ever resent on another connection.

const ACK_TIMEOUT_MS = 5_000;
/** Protective per-connection ceilings, not measured throughput targets. */
export const CELL_CONNECTION_LIMITS = { bufferedBytes: 4 * 1024 * 1024, pendingRequests: 128, inFlightSteps: 256 } as const;
/**
 * Frames read from a cell and not handled yet (they are handled one at a time, in order). At `pause*` the
 * hub stops reading the socket, so TCP pushes back on the cell, and reads again once the queue is down to
 * `resumeFrames`. A paused socket can still deliver what it had already read: past `max*` the connection
 * is closed, as an outgoing overload is.
 */
export const CELL_INBOUND_LIMITS = { pauseFrames: 64, pauseBytes: 4 * 1024 * 1024, resumeFrames: 16, maxFrames: 256, maxBytes: 16 * 1024 * 1024 } as const;

type PendingAck = { resolve: (e: Envelope) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type PendingStep = { claimId: string; resolve: (o: StepOutcome) => void; timer: NodeJS.Timeout };
type PendingReady = { resolve: (o: ReadyOutcome) => void; timer: NodeJS.Timeout };

export class CellConnection {
    readonly sessionEpoch = randomUUID();
    helloDone = false;
    closed = false;
    /** When the cell's last frame arrived (epoch ms; set at accept): a cell sends a heartbeat every 10 s. */
    lastFrameAt = 0;
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
    /** What the hello said (set when it is accepted): the capacity gauges' labels and the features frames may use. */
    isolation?: string;
    driver?: string;
    features: readonly string[] = [];
    /** The protocol version the hello ack chose: every frame of this session is sent in it. */
    version?: number;
    /** Free slots from the last heartbeat; absent before the first one. */
    freeSlots?: number;
    /** The evictedBuildStates last written for this session (its rows as one key): a heartbeat that says the same writes nothing. */
    evictedBuildStates?: string;
    /** Frames read from the cell and not handled yet, and whether reading is paused for them. */
    readonly inbound = { frames: 0, bytes: 0, paused: false };
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

    /** A frame goes out in its session's chosen version (the hub's own before hello). */
    private framed(conn: CellConnection, env: Envelope): Envelope {
        return conn.version !== undefined && env.v !== conn.version ? { ...env, v: conn.version } : env;
    }

    /** An overloaded connection becomes lost; frames are never silently dropped or resent. */
    send(conn: CellConnection, env: Envelope): boolean {
        if (conn.closed) return false;
        env = this.framed(conn, env);
        // A claim's frame carries the span that sends it (feature traceContext): the cell's spans join the Run's trace.
        if (env.claimId && !env.traceparent && conn.features.includes('traceContext')) {
            const traceparent = activeTraceparent();
            if (traceparent) env = { ...env, traceparent };
        }
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
                this.overloaded(conn, reason, { bufferedBytes: buffered, frameBytes: bytes, pendingRequests: conn.pending.size, inFlightSteps: conn.steps.size });
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

    private overloaded(conn: CellConnection, reason: 'buffer' | 'frame' | 'requests' | 'steps' | 'inbound', counts: Record<string, number>) {
        this.hubMetrics.connectionOverload(reason);
        this.log('warn', 'cell.overloaded', { cellId: conn.cred.cellId, reason, ...counts });
        this.drop(conn, 'connection overloaded');
        // close() can retain the sender's queue until its handshake times out.
        conn.socket.terminate?.();
    }

    /**
     * A frame read from the cell joins its queue (CELL_INBOUND_LIMITS): false when the connection is closed,
     * or is closed now because the queue passed its ceiling; the frame is then not handled.
     */
    admitInbound(conn: CellConnection, bytes: number): boolean {
        if (conn.closed) return false;
        const q = conn.inbound;
        if (q.frames + 1 > CELL_INBOUND_LIMITS.maxFrames || q.bytes + bytes > CELL_INBOUND_LIMITS.maxBytes) {
            this.overloaded(conn, 'inbound', { queuedFrames: q.frames, queuedBytes: q.bytes, frameBytes: bytes });
            return false;
        }
        q.frames++;
        q.bytes += bytes;
        if (!q.paused && conn.socket.pause && (q.frames >= CELL_INBOUND_LIMITS.pauseFrames || q.bytes >= CELL_INBOUND_LIMITS.pauseBytes)) {
            q.paused = true;
            conn.socket.pause();
        }
        return true;
    }

    /** An admitted frame was handled (or failed): the queue shrinks, and reading resumes once it is short again. */
    inboundHandled(conn: CellConnection, bytes: number) {
        const q = conn.inbound;
        q.frames = Math.max(0, q.frames - 1);
        q.bytes = Math.max(0, q.bytes - bytes);
        if (q.paused && !conn.closed && q.frames <= CELL_INBOUND_LIMITS.resumeFrames && q.bytes < CELL_INBOUND_LIMITS.pauseBytes) {
            q.paused = false;
            conn.socket.resume?.();
        }
    }

    /**
     * Refuses a frame. A frame that did not decode has no id to answer: it is counted and logged, not answered.
     * v sends the nack in a version other than the session's: a hello refused for its version is answered in its own.
     */
    nack(conn: CellConnection, re: string | undefined, code: string, message: string, v?: number) {
        this.metrics.recordProtocolViolation({ cellId: conn.cred.cellId, code });
        if (!re) {
            this.log('warn', 'cell.frame_refused', { cellId: conn.cred.cellId, code, detail: message.slice(0, 200) });
            return;
        }
        const env = this.envelope(conn.cred.cellId, 'nack', { code, message: message.slice(0, 1_024) }, { re });
        this.send(conn, v === undefined ? env : { ...env, v });
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

    /** The connected cells of this replica as the capacity gauges read them (HubMetrics.observeCells). */
    views(): CellCapacityView[] {
        return [...this.connections.values()]
            .filter((c) => !c.closed && c.helloDone)
            .map((c) => ({ owner: c.cred.owner, isolation: c.isolation, driver: c.driver, freeSlots: c.freeSlots, lastFrameAt: c.lastFrameAt }));
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

    /** The connection this replica holds for a cell, its hello done or not. */
    connection(cellId: string): CellConnection | undefined {
        return this.connections.get(cellId);
    }

    isCurrent(conn: CellConnection) {
        return this.connections.get(conn.cred.cellId) === conn;
    }

    /** The live connections whose cell sent no frame since `before` (epoch ms). */
    silentSince(before: number): CellConnection[] {
        return [...this.connections.values()].filter((c) => !c.closed && c.lastFrameAt < before);
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
