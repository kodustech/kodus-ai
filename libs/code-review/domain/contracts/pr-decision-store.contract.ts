/**
 * code-review — PrDecisionStore: read seam over suggestions already posted on
 * THIS pull request in a previous review round (issue #1313).
 *
 * PR-shaped by design, so it lives in `code-review`, not `agent-harness` (the
 * harness must never depend on review/PR types — see review-agent.contract.ts).
 * Modeled after the `traceDecisions` context block: historical evidence
 * injected into agent prompts, never proof the current code is correct, never
 * a filter applied before the agent runs.
 *
 * Read-only in this phase. `append` (capturing a developer's reply or a
 * resolved review thread — issue #1670) is intentionally NOT part of this
 * contract yet; when it lands, it is additive here, not a breaking change.
 */

/**
 * What happened to a previously-posted suggestion, derived from
 * `CodeSuggestion.implementationStatus`.
 *
 * `not_implemented` and `pending` are weak signals — they mean "the developer
 * hasn't applied this (yet)", NOT "the developer rejected this". There is no
 * rejection/explanation signal in this phase (that requires reading developer
 * replies or thread resolution — issue #1670, deferred).
 */
export type PrDecisionOutcome =
    | 'implemented'
    | 'partially_implemented'
    | 'not_implemented'
    | 'pending';

export interface PrDecisionRecord {
    readonly suggestionId: string;
    /** Absent for a PR-LEVEL decision — a kody-rules PULL_REQUEST-scope
     *  finding, which judges the diff as a whole and is never anchored to one
     *  file (`ISuggestionByPR`, stored in `prLevelSuggestions`, has no file
     *  field at all). A PR-level record has no `implementationStatus` either
     *  (that check only diffs file patches), so it always carries
     *  `outcome: 'pending'` — descriptive context, never refutation evidence. */
    readonly relevantFile?: string;
    readonly relevantLinesStart?: number;
    readonly relevantLinesEnd?: number;
    readonly suggestionContent: string;
    /** 'bug' | 'security' | 'performance' | ... — surfaced to the verifier so a
     *  security-labeled prior decision can be weighed differently than a style one. */
    readonly label: string;
    readonly outcome: PrDecisionOutcome;
    /** `createdAt` of the original suggestion. */
    readonly decidedAt: string;
}

export interface LoadPrDecisionsParams {
    readonly organizationId: string;
    readonly prNumber: number;
    readonly repositoryFullName: string;
    /** Only decisions touching one of these files are relevant to the current run. */
    readonly filePaths: readonly string[];
}

/**
 * Read port for prior-round decisions on a PR. Implementations are infra
 * (Mongo today); the pipeline/agents only know this seam. A failing/erroring
 * implementation must never be turned into a dropped finding by a caller —
 * callers are expected to fail open (treat an error as "no history").
 */
export interface PrDecisionStore {
    load(
        params: LoadPrDecisionsParams,
    ): Promise<readonly PrDecisionRecord[]>;
}

/** DI token, kept alongside the contract — same placement as
 *  `PULL_REQUESTS_REPOSITORY_TOKEN` in its domain contract — so a consumer
 *  depends on the domain seam, never on the infra class that implements it. */
export const PR_DECISION_STORE_TOKEN = Symbol('PrDecisionStore');
