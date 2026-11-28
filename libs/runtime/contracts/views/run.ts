import type { FindingFeedbackValue } from '@libs/runtime/api/domain/ports';
import type { RuntimeRunCost } from '@libs/runtime/api/domain/run-cost';
import type { RunPublicationView } from '@libs/runtime-publish/domain/run-publication-view';
import type { RunTargetWorkspaceRef } from '@libs/runtime-publish/domain/run-target';
import type { RuntimeRunProjection } from '@libs/runtime/run/run-projection';

// What GET /runtime/runs/:id answers, and the per-finding views it carries:
// types only, so the use case (api/application/use-cases/get-run.use-case.ts)
// and the web (apps/web/src/lib/services/runtime/contracts.ts) import the same
// shape.

/** 👍/👎 counts of one tested path, and the caller's own vote. */
export interface FindingFeedbackView {
    up: number;
    down: number;
    mine?: FindingFeedbackValue;
}

export type RuntimeRunDetail = Omit<RuntimeRunProjection, 'correlationId' | 'reproduction' | 'published' | 'publishStartedAt'> & {
    /** Findings a developer can reproduce on their machine (GET …/findings/:probeId/reproduce), by probeId. */
    reproducible: string[];
    /** What each reproducible probe sent and expected, by probeId (shape only, redacted). */
    probeRequests: Record<string, ProbeRequestView>;
    check: { conclusion: string; title: string };
    /** Machine time and LLM tokens at list prices: an estimate (§11, PR 5). */
    cost: RuntimeRunCost;
    /** By probeId. */
    feedback: Record<string, FindingFeedbackView>;
    /**
     * Findings a developer marked "this change is intended", by probeId. A
     * learning signal only: the verdict, the check and the comment still say
     * what Kody measured.
     */
    intendedBy: Record<string, FindingIntentView>;
    /**
     * What the product published on the PR, from its own publication rows
     * (ADR-052). The projection's `published` only says the Runtime asked, so
     * it is left out. Absent where the publication store is not wired.
     */
    publication?: RunPublicationView;
    /**
     * Every repository of a multi-repository Run and the commits each side
     * booted it at, as the product pinned them; absent for one repository
     * (and for a simulation, which has no target).
     */
    workspace?: RunTargetWorkspaceRef[];
    /**
     * The Run is past the longest its state may last (the hang detector's
     * bound, libs/runtime/health/stuck.ts): what the page says while the
     * maintenance loop has not ended it. Absent while it is within its bound.
     */
    stuck?: { state: string; since: string; ageMs: number; boundMs: number };
};

/**
 * What a probe sent and expected, for the finding cards: from the reproduction
 * (secrets already redacted), and only the shape of the request — never an
 * HTTP body, a SQL query or browser input text.
 */
export interface ProbeRequestView {
    kind: 'http' | 'sql' | 'browser';
    method?: string;
    service?: string;
    port?: number;
    path?: string;
    purpose: string;
    expected: string;
}

/** Who marked a finding intended, and when; `mine` when it was the caller. */
export interface FindingIntentView {
    userId: string;
    at: string;
    mine: boolean;
}
