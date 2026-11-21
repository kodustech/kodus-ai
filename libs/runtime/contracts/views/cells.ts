import type { CellTokenState, CellTopology } from '@libs/runtime/contracts/cell-token';

// What GET /runtime/cells/registration-tokens answers: types only, shared by
// the use case (api/application/use-cases/cells.use-cases.ts) and the web.

/** One registration token of the org, never the token itself: only its hash is stored. */
export interface CellRegistrationTokenView {
    id: string;
    topology: CellTopology;
    issuedBy: string;
    issuedAt: string;
    expiresAt: string;
    state: CellTokenState;
    usedAt?: string;
    revokedAt?: string;
}
