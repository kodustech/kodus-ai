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
    | 'PROVIDER_FALLBACK';

export type ReviewWarningReason =
    | 'small_context_window'
    /** The configured main provider errored, so the review used the fallback. */
    | 'provider_failover';

export interface ReviewWarning {
    kind: ReviewWarningKind;
    reason: ReviewWarningReason;
    /** Model context window that forced a fidelity drop. Not meaningful for
     *  provider-failover warnings (set to 0). */
    contextWindowTokens: number;
    modelName: string;
    /** Optional free-form context (e.g. "3 files dropped: foo.test.ts, ..."). */
    detail?: string;
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
            byKey.set(key, { ...w });
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
