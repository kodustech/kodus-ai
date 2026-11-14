/** A cell (or the hub replica that holds it) is out of reach for this call: a lost round, never a failed Run by itself. */
export class CellUnavailableError extends Error {
    readonly code: string = 'cell_unavailable';
}

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
