/** A cell (or the hub replica that holds it) is out of reach for this call: a lost round, never a failed Run by itself. */
export class CellUnavailableError extends Error {
    readonly code: string = 'cell_unavailable';
}

/**
 * The hub did not answer: the connection was refused, dropped or timed out
 * (a replica restarting). An idempotent call (an acquire by its key) may ask
 * again; the cell keeps preparing a claim it was asked for.
 */
export class HubUnreachableError extends CellUnavailableError {}

/**
 * The cell directory found no host connected for the organization at all
 * (reserveCell null): on a claim's first ask the Run ends at once with the
 * cell_unavailable card (capacity-wait.ts); while it waits for room, a pause
 * (a hub restarting drops its cells for a moment).
 */
export class NoCellConnectedError extends CellUnavailableError {}

/** Release was acknowledged; authoritative cell absence is still required. */
export class MemberCleanupPendingError extends CellUnavailableError {
    readonly code = 'member_cleanup_pending';
    constructor() {
        super('member_cleanup_pending');
    }
}

/** The hub refused an internal request with a structured 409 response. */
export class HubRefused extends Error {
    constructor(readonly body: { code: string; message: string }) {
        super(`${body.code}: ${body.message}`);
    }
}
