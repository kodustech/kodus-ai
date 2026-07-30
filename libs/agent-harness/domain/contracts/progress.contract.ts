/**
 * agent-harness — Progress port (generic, domain supplies the ledger).
 *
 * "Progress" is the generic notion of "did the agent actually address the
 * declared targets before finalizing". The CONCEPT is domain-agnostic; the
 * concrete ledger is domain-supplied:
 *   - code-review: targets = changed hunks (range-based diff coverage)
 *   - docs-qa:     targets = the retrieved documents
 *
 * The CompletionGatePolicy consumes this port; the domain implements it (e.g. by
 * wrapping its own diff-hunk coverage ledger).
 */
export interface ProgressSummary {
    readonly totalTargets: number;
    readonly pendingTargets: number;
    /** Critical-tier targets (must be addressed before finalizing). */
    readonly criticalTotal: number;
    readonly criticalPending: number;
}

export interface ProgressLedger {
    /** Update progress from a tool call the agent just made (range-aware in
     *  the code-review impl: a narrow read does NOT cover a hunk it missed). */
    markFromToolCall(toolName: string, input: unknown, step: number): void;
    /** Current progress snapshot. */
    summary(): ProgressSummary;
    /** Human-readable debt to inject into the next step, or null if none. */
    debtNote(): string | null;
}
