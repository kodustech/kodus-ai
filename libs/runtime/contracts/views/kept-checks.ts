import type { KeptCheckOutcomeKind, KeptCheckStaleReason } from '@libs/runtime/contracts/kept-check';

// What the /runtime/kept-checks routes answer (docs/runtime/kept-checks.md):
// types only, shared by the use cases (api/application/use-cases/kept-checks.use-cases.ts)
// and, once a screen is decided, the web.

/** One kept check as the product shows it: what it sends, what it guards, where it came from and how it did last. */
export interface RuntimeKeptCheckView {
    keptCheckId: string;
    environmentId: string;
    repositoryId: string;
    kind: 'http' | 'browser';
    /** What the check sends, from its typed spec (`GET /orders/1`), redacted. */
    exercised?: string;
    entryPoint: string;
    differingFields: string[];
    source: { runId: string; probeId: string; prNumber: number };
    keptBy: string;
    keptAt: string;
    /** Its last Run's outcome; absent: no Run played it yet, or the Runtime database could not be read. */
    last?: { outcome: KeptCheckOutcomeKind; staleReason?: KeptCheckStaleReason; runId: string; prNumber: number; at: string };
    /** The last outcome is stale: main no longer has what it guarded, until someone removes it. */
    stale: boolean;
    /** Distinct PRs other than the one it was kept from where it failed. */
    failuresOnLaterPrs: number;
}

/** GET /runtime/kept-checks: the active checks, stale ones first, and the metric of the scope. */
export interface RuntimeKeptChecksView {
    checks: RuntimeKeptCheckView[];
    /** Regressions blocked by a kept check in this scope (§10), removed checks included. */
    failuresOnLaterPrs: number;
    /** How many active checks the scope may hold. */
    limit: number;
    /** The Runtime database could not be read: outcomes and the metric are missing, not zero. */
    outcomesUnavailable?: true;
}

/** POST /runtime/kept-checks: the check, and whether this call kept it (false: it was kept already). */
export interface RuntimeKeepCheckView {
    created: boolean;
    check: RuntimeKeptCheckView;
}
