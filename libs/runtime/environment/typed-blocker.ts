import { classifyBlocker } from '@libs/runtime/blockers/catalog';
import { BLOCKER_KINDS, type BlockerKind } from '@libs/runtime/contracts/enums';

import type { Blocked, Blocker } from './environment-runtime';

// A blocked acquire typed for the port's callers (docs §5): the kind among
// BLOCKER_KINDS, and the shared catalog's card for it. Applied at the
// worker's border with the hub (HubEnvironmentClient.acquire), where an
// answer from a newer hub may name a kind this worker does not know.

/** A blocker kind as this side knows it: one of BLOCKER_KINDS, or `unknown`. */
export function blockerKindOf(kind: unknown): BlockerKind {
    return typeof kind === 'string' && (BLOCKER_KINDS as readonly string[]).includes(kind) ? (kind as BlockerKind) : 'unknown';
}

/** One blocker typed and given the catalog's title, evidence and fixes; every other field kept. */
export function typedBlocker(b: Blocker): Blocker {
    const kind = blockerKindOf(b.kind);
    const card = classifyBlocker({ kind, signature: b.signature, message: b.message, ...(b.bundle ? { bundle: b.bundle } : {}) });
    const evidence = { ...(b.evidence ?? {}), lines: card.evidence.lines, ...(card.evidence.service ? { service: card.evidence.service } : {}) };
    return { ...b, kind, title: card.title, evidence, fixes: card.fixes };
}

/** A blocked acquire with each blocker typed (typedBlocker); held, cell and capacity kept. */
export function typedBlocked(r: Blocked): Blocked {
    return { ...r, blockers: (r.blockers ?? []).map(typedBlocker) };
}
