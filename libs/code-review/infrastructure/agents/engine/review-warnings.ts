/**
 * Structured warnings emitted when the pipeline drops review fidelity to
 * fit a small model context window. Surfaced to the user as a collapsible
 * notice in the end-review PR comment; also captured in telemetry so we
 * can roll up "how often does each kind fire" per provider.
 *
 * PR1 ships the types + dedup helper but does NOT emit warnings anywhere
 * yet — `resolveAdaptiveProfile` still returns full-fidelity flags so no
 * strategy fires. PR2/PR3 wire emission per strategy.
 */

import type { ModelFailoverEvent } from '@libs/llm/model-failover';

export type ReviewWarningKind =
    /** Compact system prompt was used (workflow/rules trimmed). */
    | 'PROMPT_COMPACTED'
    /** Pre-computed call graph was omitted from the user prompt. */
    | 'CALLGRAPH_DROPPED'
    /** All file diffs rendered as hunk headers only. */
    | 'HUNK_HEADERS_ONLY'
    /** At least one file's diff was truncated to the max-chars cap. */
    | 'DIFF_TRUNCATED'
    /** Low-signal files (tests/md/css) dropped even in deep mode. */
    | 'LOW_SIGNAL_FILES_DROPPED'
    /** Verifier / second-chance / rescue passes skipped. */
    | 'HEAVY_PASSES_SKIPPED'
    /** The BYOK main provider failed and the review ran on the fallback. */
    | 'PROVIDER_FALLBACK'
    /** Kody Rules were not judged because the context they declared they need
     *  could not be retrieved from the repository. */
    | 'RULE_CONTEXT_UNAVAILABLE'
    /** A finding's `improvedCode` was empty, identical to `existingCode`, or
     *  syntactically truncated, so it was published as a plain comment with
     *  no code block instead of the (unusable) fix. */
    | 'BAD_FIX_DOWNGRADED'
    /** No repository checkout: the agents reviewed the diff alone, with no
     *  tools and no call graph. */
    | 'SANDBOX_UNAVAILABLE'
    /** The repository was checked out, but building the call graph failed. */
    | 'CALLGRAPH_FAILED'
    /** Findings were dropped because the file they named is not in the PR. */
    | 'SUGGESTIONS_DROPPED_PATH_MISMATCH'
    /** Some Kody Rules checks failed to run; the others still posted. */
    | 'KODY_RULES_PARTIAL';

export type ReviewWarningReason =
    | 'small_context_window'
    /** The configured main provider errored, so the review used the fallback. */
    | 'provider_failover'
    /** The repository could not be looked at, so a declared context need went
     *  unmet. */
    | 'lookup_unavailable'
    /** `improvedCode` failed the publication gate (issue #1833). */
    | 'unusable_fix'
    /** The sandbox could not be created for this review. */
    | 'sandbox_unavailable'
    /** The call graph build threw during the review. */
    | 'callgraph_failed'
    /** A finding named a file outside the PR's changed files. */
    | 'path_mismatch'
    /** A Kody Rules judge shard errored. */
    | 'judge_shard_failed'
    /** The prompt did not fit the single-batch budget on a large PR. */
    | 'large_pr';

export interface ReviewWarning {
    kind: ReviewWarningKind;
    reason: ReviewWarningReason;
    /** Model context window that forced a fidelity drop. Not meaningful for
     *  provider-failover warnings (set to 0). */
    contextWindowTokens: number;
    modelName: string;
    /** Optional free-form context (e.g. "3 files dropped: foo.test.ts, ..."). */
    detail?: string;
    /** Titles of the Kody Rules this warning is about, kept structured so the
     *  end-review PR comment can render them without parsing `detail`. Only
     *  `RULE_CONTEXT_UNAVAILABLE` populates it. */
    ruleTitles?: string[];
    /** Agent that emitted the warning. Cleared on dedup when multiple agents
     *  emit the same warning, since the underlying cause is pipeline-wide. */
    agentName?: string;
}

/**
 * Build the notice shown (in the admin dashboard, via
 * dataExecution.reviewWarnings) when an agent's BYOK main provider failed and
 * the review completed on the configured fallback. `contextWindowTokens` is 0
 * because it is a provider-health signal, not a context-window fidelity drop —
 * so per-agent duplicates fold to a single dashboard entry.
 */
export function buildProviderFallbackWarning(params: {
    failedModel: string;
    usedModel: string;
    agentName?: string;
}): ReviewWarning {
    return {
        kind: 'PROVIDER_FALLBACK',
        reason: 'provider_failover',
        contextWindowTokens: 0,
        modelName: params.usedModel,
        detail: `main provider ${params.failedModel} failed; review ran on fallback ${params.usedModel}`,
        agentName: params.agentName,
    };
}

/**
 * One PROVIDER_FALLBACK warning per model the review fell back to, merged into
 * the run's warnings. Leaves `warnings` untouched when nothing failed over.
 */
export function withFallbackWarnings(
    warnings: ReviewWarning[] | undefined,
    failovers: Array<Pick<ModelFailoverEvent, 'failedModel' | 'usedModel'>>,
): ReviewWarning[] | undefined {
    if (!failovers.length) {
        return warnings;
    }
    return dedupReviewWarnings([
        ...(warnings ?? []),
        ...failovers.map((f) =>
            buildProviderFallbackWarning({
                failedModel: f.failedModel,
                usedModel: f.usedModel,
            }),
        ),
    ]);
}

/**
 * Losses a review used to record only in its logs (#2066): the review still
 * succeeds, so without these it reads exactly like a full one. Admin-facing
 * (dashboard, doctor); none of them is rendered in the PR comment.
 */
export function buildSandboxUnavailableWarning(params: {
    modelName: string;
}): ReviewWarning {
    return {
        kind: 'SANDBOX_UNAVAILABLE',
        reason: 'sandbox_unavailable',
        contextWindowTokens: 0,
        modelName: params.modelName,
        detail: 'the repository could not be checked out, so the review read only the diff (no tools, no call graph)',
    };
}

export function buildCallGraphFailedWarning(params: {
    modelName: string;
}): ReviewWarning {
    return {
        kind: 'CALLGRAPH_FAILED',
        reason: 'callgraph_failed',
        contextWindowTokens: 0,
        modelName: params.modelName,
        detail: 'the call graph could not be built, so the review ran without knowing who calls the changed code',
    };
}

export function buildPathMismatchWarning(params: {
    count: number;
    modelName: string;
    agentName: string;
}): ReviewWarning {
    return {
        kind: 'SUGGESTIONS_DROPPED_PATH_MISMATCH',
        reason: 'path_mismatch',
        contextWindowTokens: 0,
        modelName: params.modelName,
        detail: `${params.agentName}: ${params.count} finding(s) dropped because the file they named is not in the pull request`,
        agentName: params.agentName,
    };
}

export function buildKodyRulesPartialWarning(params: {
    failed: number;
    total: number;
    modelName: string;
    agentName: string;
}): ReviewWarning {
    return {
        kind: 'KODY_RULES_PARTIAL',
        reason: 'judge_shard_failed',
        contextWindowTokens: 0,
        modelName: params.modelName,
        detail: `${params.failed} of ${params.total} Kody Rules check(s) failed to run; the rules on them were not applied`,
        agentName: params.agentName,
    };
}

/**
 * Fold duplicate warnings across the per-agent fan-out. Without this the
 * end-review comment would render the same `PROMPT_COMPACTED` notice 4
 * times (bug + security + performance + kody-rules).
 *
 * Dedup key: (kind, modelName, contextWindowTokens). Within a group,
 * `detail` strings are deduped and comma-joined, and `agentName` is
 * cleared because the warning is no longer agent-specific.
 *
 * Order is preserved by first occurrence so the user sees them in the
 * order strategies fired.
 */
export function dedupReviewWarnings(
    warnings: ReviewWarning[],
): ReviewWarning[] {
    if (warnings.length === 0) return [];

    const byKey = new Map<string, ReviewWarning>();
    const detailsByKey = new Map<string, string[]>();

    for (const w of warnings) {
        const key = `${w.kind}::${w.modelName}::${w.contextWindowTokens}`;
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, {
                ...w,
                ...(w.ruleTitles ? { ruleTitles: [...w.ruleTitles] } : {}),
            });
            if (w.detail) detailsByKey.set(key, [w.detail]);
            continue;
        }
        // Merging a second occurrence: warning is no longer agent-specific.
        existing.agentName = undefined;
        if (w.detail) {
            const seen = detailsByKey.get(key) ?? [];
            if (!seen.includes(w.detail)) {
                seen.push(w.detail);
                detailsByKey.set(key, seen);
            }
        }
        // Titles union, not overwrite: a rule skipped by a second emitter has
        // to stay named in the PR comment.
        if (w.ruleTitles?.length) {
            const merged = existing.ruleTitles ?? [];
            for (const title of w.ruleTitles) {
                if (!merged.includes(title)) merged.push(title);
            }
            existing.ruleTitles = merged;
        }
    }

    // Stitch comma-joined details back onto the surviving entries.
    for (const [key, entry] of byKey) {
        const details = detailsByKey.get(key);
        if (details && details.length > 0) {
            entry.detail = details.join(', ');
        }
    }

    return Array.from(byKey.values());
}

/**
 * Build the notice for Kody Rules that were NOT judged because the repository
 * context they declared they need could not be retrieved (issue #1826).
 *
 * A skipped rule has to be visible: silence here reads exactly like "your rule
 * found nothing", which is the failure the whole feature exists to remove. Like
 * the provider-failover notice this is a capability signal, not a
 * context-window fidelity drop, so `contextWindowTokens` is 0 and per-agent
 * duplicates fold to one entry.
 */
export function buildRuleContextUnavailableWarning(params: {
    skippedRuleTitles: string[];
    modelName: string;
    agentName?: string;
}): ReviewWarning {
    const titles = params.skippedRuleTitles.join(', ');
    return {
        kind: 'RULE_CONTEXT_UNAVAILABLE',
        reason: 'lookup_unavailable',
        contextWindowTokens: 0,
        modelName: params.modelName,
        detail: `${params.skippedRuleTitles.length} Kody Rule(s) were not evaluated because the repository context they need could not be retrieved: ${titles}`,
        ruleTitles: [...params.skippedRuleTitles],
        agentName: params.agentName,
    };
}

/**
 * Build the notice for findings dropped by the `improvedCode` publication
 * gate (issue #1833) — empty, identical to `existingCode`, prose-only, or
 * truncated fixes. A silent drop here would look like the review found less
 * than it did; this makes the count visible instead of just quietly shrinking
 * the suggestion list. `contextWindowTokens` is 0 for the same reason as the
 * other capability-signal warnings above: it is not a fidelity trade-off.
 */
export function buildBadFixDowngradedWarning(params: {
    count: number;
    modelName: string;
    agentName?: string;
}): ReviewWarning {
    return {
        kind: 'BAD_FIX_DOWNGRADED',
        reason: 'unusable_fix',
        contextWindowTokens: 0,
        modelName: params.modelName,
        detail: `${params.count} suggestion(s) were published without their code suggestion because the proposed fix was empty, identical to the existing code, or truncated`,
        agentName: params.agentName,
    };
}

/**
 * An agent that degrades so badly it cannot report a result still has something
 * the PR must say. `Promise.allSettled` keeps only a fulfilled agent's
 * `warnings`, so a thrown agent used to lose them: the Kody Rules all-skipped
 * escalation named every skipped rule in its message, and that message is
 * rendered only for a FAILED review — kody-rules is not critical, so the review
 * is partial and the names never reached the PR (Verifier round 2, gap 2).
 * Carrying them on the error lets the orchestrator harvest them on rejection,
 * so the escalation and the notice say the same thing.
 */
export class AgentDegradedError extends Error {
    constructor(
        message: string,
        readonly warnings: ReviewWarning[],
    ) {
        super(message);
        this.name = 'AgentDegradedError';
    }
}

/** The warnings an agent attached to whatever it threw, if any. */
export function warningsFromError(err: unknown): ReviewWarning[] {
    const carried = (err as { warnings?: unknown } | null)?.warnings;
    return Array.isArray(carried) ? (carried as ReviewWarning[]) : [];
}
