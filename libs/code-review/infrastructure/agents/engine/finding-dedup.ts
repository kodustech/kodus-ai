/**
 * Suggestion dedup: collapses findings that describe the same issue. Moved out
 * of `AgentReviewStage` (`libs/code-review/pipeline/stages/agent-review.stage.ts`)
 * without behavior change, so a caller other than the review (e.g. the
 * security scan) runs exactly the same dedup on its findings.
 *
 * The stage keeps its private methods (`deduplicateSuggestions`,
 * `resolveDedupMerge`, `buildDedupTiebreak`, `summarizeDedupSuggestion`,
 * `embedDedupSuggestion`) as delegations that hand `this`-bound callbacks in
 * through `FindingDedupDeps`, so the specs and evals that spy on or patch
 * them still intercept every call. Another caller wires the defaults with
 * `createFindingDedupDeps`.
 */
import { jsonSchema, type EmbeddingModel } from 'ai';

import type { createLogger } from '@libs/core/log/logger';
import { type LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';
import type { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { tracedEmbed as embed } from '@libs/llm/llm-call';
import { LLM } from '@libs/llm/llm';
import { hasManagedModelKey } from '@libs/llm/managed-slot';
import type { NormalizedModel } from '@libs/llm/byok-config';
import {
    normalizeEnvelope,
    LLM_ENVELOPE_TAG,
} from '@libs/llm/structured-output-repair';
import { buildPlatformEmbedder } from '@libs/common/utils/document';
import type {
    DedupTraceGroupSummary,
    DedupTraceSuggestionSummary,
    DedupTraceSummary,
} from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import {
    DEDUP_SCHEMA,
    DEDUP_CONTENT_THRESHOLD,
    DEDUP_EMBEDDING_LOW,
    DEDUP_EMBEDDING_HIGH,
    DEDUP_TIEBREAK_SCHEMA,
    DEDUP_FOLLOWUP_SCHEMA,
    applyDedupFollowup,
    buildDedupFollowupPrompt,
    buildDedupPrompt,
    buildTiebreakPrompt,
    unclassifiedDedupIndices,
    contentSimilarity,
    cosineSimilarity,
    dedupEmbeddingText,
} from '@libs/code-review/infrastructure/agents/engine/dedup-prompt';
import { preferAnalyzerKeep } from '@libs/code-review/infrastructure/agents/engine/prefer-analyzer-keep';
import {
    isSameSpot,
    preferSpecificKeep,
} from '@libs/code-review/infrastructure/agents/engine/prefer-specific-keep';
import {
    bothFromAnalyzers,
    restatesAnalyzerFinding,
} from '@libs/code-review/infrastructure/agents/engine/restates-analyzer-finding';
import {
    keepOwnFindingsApart,
    preferCustomAgentKeep,
} from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-presentation';

export type FindingDedupLogger = ReturnType<typeof createLogger>;

/** Where the dedup logs go: the caller's logger, under the caller's context. */
export interface FindingDedupLog {
    logger: FindingDedupLogger;
    context: string;
}

/** Pairwise "same bug?" check; null when the model could not answer. */
export type DedupTiebreak = (
    a: Partial<CodeSuggestion>,
    b: Partial<CodeSuggestion>,
) => Promise<boolean | null>;

/** Description embeddings memoized per dedup run, by suggestion key. */
export type DedupEmbedCache = Map<string, number[] | null>;

/** The review a dedup runs for, on the warnings it logs. */
export interface DedupLogMeta {
    prNumber?: number;
    organizationId?: string;
    teamId?: string;
}

export interface DedupMergeOptions {
    crossStream?: boolean;
    logMeta?: DedupLogMeta;
}

export interface DedupMergeDecision {
    honor: boolean;
    reason: string;
    score: number;
}

/** What `deduplicateFindings` calls back into. */
export interface FindingDedupDeps extends FindingDedupLog {
    summarize(
        suggestion?: Partial<CodeSuggestion>,
    ): DedupTraceSuggestionSummary;
    resolveMerge(
        dup: Partial<CodeSuggestion>,
        keep: Partial<CodeSuggestion>,
        dupKey: string,
        keepKey: string,
        embedCache: DedupEmbedCache,
        tiebreak: DedupTiebreak,
        opts?: DedupMergeOptions,
    ): Promise<DedupMergeDecision>;
    buildTiebreak(
        byokConfig: NormalizedModel | undefined,
        telemetryMeta: LangfuseTelemetryMetadata | undefined,
        prNumber: number,
    ): DedupTiebreak;
}

export function summarizeDedupSuggestion(
    suggestion?: Partial<CodeSuggestion>,
): DedupTraceSuggestionSummary {
    return {
        relevantFile: suggestion?.relevantFile,
        relevantLinesStart: suggestion?.relevantLinesStart,
        relevantLinesEnd: suggestion?.relevantLinesEnd,
        label: suggestion?.label,
        severity: suggestion?.severity,
        oneSentenceSummary:
            suggestion?.oneSentenceSummary ||
            suggestion?.suggestionContent?.substring(0, 200),
    };
}

/** Embed a suggestion's description once per dedup run (memoized by index).
 * Fail-soft: no platform embedding key or any error → null, so the caller
 * falls back to the pre-#1527 lexical behavior (veto) instead of crashing. */
export async function embedDedupSuggestion(
    deps: FindingDedupLog & { getEmbedder(): EmbeddingModel | null },
    suggestion: Partial<CodeSuggestion>,
    key: string,
    cache: DedupEmbedCache,
    logMeta?: DedupLogMeta,
): Promise<number[] | null> {
    if (cache.has(key)) {
        return cache.get(key) ?? null;
    }
    let vector: number[] | null = null;
    try {
        const text = dedupEmbeddingText(suggestion as any);
        const embedder = deps.getEmbedder();
        if (text && embedder) {
            const { embedding } = await embed({
                model: embedder,
                value: text,
            });
            vector = embedding;
        }
    } catch (err) {
        deps.logger.warn({
            message: `[DEDUP-GUARD] embedding unavailable, falling back to the tiebreak`,
            context: deps.context,
            error: err,
            ...(logMeta ? { metadata: logMeta } : {}),
        });
        vector = null;
    }
    cache.set(key, vector);
    return vector;
}

/**
 * Tiered dedup guard (PR #1527): decide whether to honor a merge.
 *   1. lexical overlap ≥ threshold → honor (cheap, obvious duplicates);
 *   2. else semantic cosine of the two descriptions:
 *        ≥ HIGH → honor, < LOW → veto, in-between → LLM tiebreak (full text).
 * Without an embedding (no embedder, or the call failed) the tiebreak
 * decides the model's proposed merges (#2170). A tiebreak failure falls
 * back to a veto, so a low-overlap merge is never honored blindly.
 *
 * `crossStream` mode (Kody-Rule vs suggestion): there is NO prior LLM
 * grouping to corroborate a match, so the cheap lexical-honor shortcut is
 * skipped — only a strong semantic signal (embedding-high or a tiebreak yes)
 * may absorb a suggestion into a rule, keeping false absorptions near zero.
 */
export async function resolveDedupMerge(
    deps: {
        embed(
            suggestion: Partial<CodeSuggestion>,
            key: string,
            cache: DedupEmbedCache,
            logMeta?: DedupLogMeta,
        ): Promise<number[] | null>;
    },
    dup: Partial<CodeSuggestion>,
    keep: Partial<CodeSuggestion>,
    dupKey: string,
    keepKey: string,
    embedCache: DedupEmbedCache,
    tiebreak: DedupTiebreak,
    opts?: DedupMergeOptions,
): Promise<DedupMergeDecision> {
    const lexical = contentSimilarity(dup, keep);

    // Two scanner findings are never duplicates of each other — there is
    // one suggestion per tool, so the only pair is secrets vs dependencies.
    // Honoring it would not drop a duplicate; it would drop a whole
    // category's comment, because the merge keeps only the representative.
    if (bothFromAnalyzers(dup, keep)) {
        return {
            honor: false,
            reason: 'distinct-analyzers',
            score: lexical,
        };
    }

    if (!opts?.crossStream && lexical >= DEDUP_CONTENT_THRESHOLD) {
        return { honor: true, reason: 'lexical', score: lexical };
    }

    const [vecDup, vecKeep] = await Promise.all([
        deps.embed(dup, dupKey, embedCache, opts?.logMeta),
        deps.embed(keep, keepKey, embedCache, opts?.logMeta),
    ]);
    if (!vecDup || !vecKeep) {
        // A scanner fact the model restated is the duplicate we are most
        // sure about: it merges without asking. Where embeddings work, the
        // full guard still decides, so a wide agent finding that merely
        // overlaps a scanner line is not swallowed.
        if (restatesAnalyzerFinding(dup, keep)) {
            return {
                honor: true,
                reason: 'restates-analyzer (no-embed)',
                score: lexical,
            };
        }
        // No embedding (a self-hosted install without the platform OpenAI
        // key, or a failed call, #2170): the model proposed this merge, so
        // the tiebreak decides it. The cross-stream pass has no such proposal and
        // would ask once per suggestion × rule pair: it keeps the veto.
        if (!opts?.crossStream) {
            const sameBug = await tiebreak(dup, keep);
            if (sameBug !== null) {
                return {
                    honor: sameBug,
                    reason: `llm-tiebreak=${sameBug} (no-embed)`,
                    score: lexical,
                };
            }
        }
        return {
            honor: false,
            reason: 'lexical-veto (no-embed)',
            score: lexical,
        };
    }

    const cos = cosineSimilarity(vecDup, vecKeep);
    if (cos >= DEDUP_EMBEDDING_HIGH) {
        return { honor: true, reason: 'embedding-high', score: cos };
    }
    if (cos < DEDUP_EMBEDDING_LOW) {
        return { honor: false, reason: 'embedding-low', score: cos };
    }

    const sameBug = await tiebreak(dup, keep);
    if (sameBug === null) {
        return { honor: false, reason: 'tiebreak-error-veto', score: cos };
    }
    return {
        honor: sameBug,
        reason: `llm-tiebreak=${sameBug}`,
        score: cos,
    };
}

/**
 * Build the pairwise "same bug?" tiebreak used by both the within-stream
 * dedup guard and the cross-stream (Kody-Rule vs suggestion) dedup. Resolves
 * the secondary model the same way the batch dedup does; any failure returns
 * null so the caller vetoes (keeps both).
 */
export function buildDedupTiebreak(
    deps: FindingDedupLog,
    byokConfig: NormalizedModel | undefined,
    telemetryMeta: LangfuseTelemetryMetadata | undefined,
    prNumber: number,
): DedupTiebreak {
    return async (a, b) => {
        try {
            // ONE primitive: LLM.run resolves the slot (or managed default),
            // owns the span + json_schema→json_object fallback, and returns the
            // parsed object. `runName` reproduces the 'dedup-tiebreak' trace.
            const out = (await LLM.run({
                byokConfig,
                schema: jsonSchema(DEDUP_TIEBREAK_SCHEMA as any),
                user: buildTiebreakPrompt(a as any, b as any),
                runName: 'dedup-tiebreak',
                organizationId: telemetryMeta?.organizationId,
                telemetryMetadata: telemetryMeta,
            })) as any;
            return typeof out?.sameBug === 'boolean' ? out.sameBug : null;
        } catch (err) {
            deps.logger.warn({
                message: `[DEDUP-GUARD] PR#${prNumber}: tiebreak failed, vetoing merge`,
                context: deps.context,
                error: err,
            });
            return null;
        }
    };
}

/**
 * Deduplicate suggestions that describe the same issue using LLM.
 * Groups by file, then asks Gemini Flash which suggestions are duplicates.
 */
export async function deduplicateFindings(
    deps: FindingDedupDeps,
    suggestions: Partial<CodeSuggestion>[],
    prNumber: number,
    resolvedSlot?: NormalizedModel,
    telemetryMeta?: LangfuseTelemetryMetadata,
): Promise<{
    suggestions: Partial<CodeSuggestion>[];
    trace: DedupTraceSummary;
}> {
    // The dedup pass runs on the bare resolved model slot (or the managed
    // default, resolved inside LLM.run).
    const dedupSlot = resolvedSlot ?? undefined;
    if (suggestions.length <= 1) {
        return {
            suggestions,
            trace: {
                status: 'skipped',
                totalClassifiedCount: suggestions.length,
                kodyRulesSkippedCount: 0,
                nonKodyInputCount: suggestions.length,
                nonKodyOutputCount: suggestions.length,
                finalOutputCount: suggestions.length,
                uniqueCount: suggestions.length,
                groupsCount: 0,
                removedCount: 0,
                unique: suggestions.map((suggestion) =>
                    deps.summarize(suggestion),
                ),
            },
        };
    }

    try {
        // Graceful no-model (self-hosted, no key): skip dedup and keep all,
        // the same everywhere — so dev/CI doesn't fail-loud on a missing key
        // (LLM.run no longer throws the old NoStructuredFallbackModelError the
        // catch below keyed off). A model resolves when there's a BYOK slot OR
        // a managed/env default key is configured — the exact condition the
        // removed `resolveSecondaryPassModel` (→ getInternalModel) checked.
        if (!dedupSlot && !hasManagedModelKey()) {
            deps.logger.warn({
                message: `[DEDUP] PR#${prNumber}: no secondary model available, keeping all suggestions`,
                context: deps.context,
            });
            return {
                suggestions,
                trace: {
                    status: 'skipped',
                    totalClassifiedCount: suggestions.length,
                    kodyRulesSkippedCount: 0,
                    nonKodyInputCount: suggestions.length,
                    nonKodyOutputCount: suggestions.length,
                    finalOutputCount: suggestions.length,
                    uniqueCount: suggestions.length,
                    groupsCount: 0,
                    removedCount: 0,
                    unique: suggestions.map((suggestion) =>
                        deps.summarize(suggestion),
                    ),
                },
            };
        }

        // ONE primitive: LLM.run resolves the slot (or the managed default),
        // owns the json_schema→json_object fallback, and records the dedup
        // usage span ITSELF — agent.name/phase derived from the 'code-review::
        // dedup' spanName — so the manual recordAgentRunUsage is gone. Returns
        // the parsed dedup object directly.
        const dedupOutput = (await LLM.run({
            byokConfig: resolvedSlot,
            schema: jsonSchema(DEDUP_SCHEMA as any),
            user: buildDedupPrompt(suggestions),
            runName: 'code-review-dedup',
            spanName: 'code-review::dedup',
            organizationId: telemetryMeta?.organizationId,
            telemetryMetadata: telemetryMeta,
            // Parity with the old recordAgentRunUsage: the dedup span keeps
            // its type + per-PR/team attribution (the model/credential keys
            // are derived from the slot inside LLM.run).
            attrs: {
                type: dedupSlot ? 'byok' : 'system',
                prNumber,
                ...(telemetryMeta?.teamId
                    ? { teamId: telemetryMeta.teamId }
                    : {}),
            },
        })) as any;

        deps.logger.log({
            message: `[DEDUP-DEBUG] PR#${prNumber}: input=${suggestions.length}, groups=${dedupOutput?.groups?.length ?? 0}, unique=${dedupOutput?.unique?.length ?? 0}`,
            context: deps.context,
        });

        // SHAPE recovery (#1786): a non-strict model may wrap
        // ({result:{groups,unique}}), rename, stringify, or bare-array the
        // dedup output — recover the canonical shape before reading, so an
        // off-schema envelope does not fold into 'keep-all' and ship
        // duplicate comments.
        const normalizedDedup = normalizeEnvelope(
            dedupOutput,
            'groups',
            ['duplicateGroups', 'duplicates'],
            {
                onRecover: (reason) =>
                    deps.logger.warn({
                        message: `${LLM_ENVELOPE_TAG} recovered off-schema dedup output (${reason}) for PR#${prNumber}`,
                        context: deps.context,
                    }),
            },
        ) as any;

        // The model ranks `keep` by how a finding reads, which always
        // favours its own prose over a scanner's, and the longest text over
        // the one on the defective lines. Re-seat the roles so a
        // deterministic finding survives the group it was merged into, and
        // otherwise the finding anchored on the lines at fault. The
        // follow-up sees the scanner re-seat; the rest runs on the final
        // groups below.
        let groups: Array<{
            keep: number;
            duplicates: number[];
        }> = preferAnalyzerKeep(normalizedDedup?.groups || [], suggestions);
        let unique: number[] = normalizedDedup?.unique || [];

        // A model can stop partway through the list. The left-out
        // suggestions go back in one short call that sees what was already
        // decided; any still left out falls to the safety net below.
        const leftOut =
            groups.length || unique.length
                ? unclassifiedDedupIndices(suggestions.length, groups, unique)
                : [];
        // Kept in the dedup trace: a failed follow-up keeps those
        // suggestions as they were (a duplicate may reach the PR), the same
        // way a failed dedup keeps everything, without degrading the review.
        let followupError: string | undefined;
        if (leftOut.length > 0) {
            try {
                // The same shape recovery as the first answer (#1786): a
                // wrapped, bare-array or stringified answer still counts,
                // and one with no assignments fails like a failed call.
                const followupOutput = await LLM.run({
                    byokConfig: resolvedSlot,
                    schema: jsonSchema(DEDUP_FOLLOWUP_SCHEMA as any),
                    user: buildDedupFollowupPrompt(
                        suggestions,
                        groups,
                        unique,
                        leftOut,
                    ),
                    runName: 'code-review-dedup-followup',
                    spanName: 'code-review::dedup',
                    organizationId: telemetryMeta?.organizationId,
                    telemetryMetadata: telemetryMeta,
                    attrs: {
                        type: dedupSlot ? 'byok' : 'system',
                        prNumber,
                        ...(telemetryMeta?.teamId
                            ? { teamId: telemetryMeta.teamId }
                            : {}),
                    },
                });
                const followup = normalizeEnvelope(
                    followupOutput,
                    'assignments',
                    [],
                    {
                        onRecover: (reason) =>
                            deps.logger.warn({
                                message: `${LLM_ENVELOPE_TAG} recovered off-schema dedup follow-up output (${reason}) for PR#${prNumber}`,
                                context: deps.context,
                            }),
                    },
                ) as any;
                if (!Array.isArray(followup?.assignments)) {
                    throw new Error('the follow-up answer has no assignments');
                }
                ({ groups, unique } = applyDedupFollowup(
                    suggestions.length,
                    groups,
                    unique,
                    leftOut,
                    followup.assignments,
                ));
                deps.logger.log({
                    message: `[DEDUP-FOLLOWUP] PR#${prNumber}: ${leftOut.length} left out, ${unclassifiedDedupIndices(suggestions.length, groups, unique).length} still left out after the follow-up`,
                    context: deps.context,
                });
            } catch (error) {
                followupError =
                    error instanceof Error ? error.message : String(error);
                deps.logger.warn({
                    message: `[DEDUP-FOLLOWUP] PR#${prNumber}: follow-up for ${leftOut.length} left-out suggestions failed, safety net keeps them`,
                    context: deps.context,
                    error,
                    metadata: {
                        organizationId: telemetryMeta?.organizationId,
                        teamId: telemetryMeta?.teamId,
                        prNumber,
                        leftOutCount: leftOut.length,
                    },
                });
            }
        }

        // After the follow-up, so a custom agent's finding taken back out
        // of a group is not sent to it again and stays unique.
        groups = keepOwnFindingsApart(
            preferCustomAgentKeep(
                preferSpecificKeep(
                    preferAnalyzerKeep(groups, suggestions),
                    suggestions,
                    unique,
                ),
                suggestions,
            ),
            suggestions,
        );

        // Semantic tier of the content guard (PR #1527): when lexical overlap
        // is inconclusive we compare description embeddings, and only escalate
        // the ambiguous band to a focused LLM tiebreak. Embeddings are memoized
        // per suggestion for this dedup run.
        const embedCache = new Map<string, number[] | null>();
        const runTiebreak = deps.buildTiebreak(
            dedupSlot,
            telemetryMeta,
            prNumber,
        );

        // Safety: if LLM returns nothing useful, keep all
        if (groups.length === 0 && unique.length === 0) {
            deps.logger.warn({
                message: `[DEDUP] PR#${prNumber}: LLM returned empty result, keeping all ${suggestions.length} suggestions`,
                context: deps.context,
            });
            return {
                suggestions,
                trace: {
                    status: 'empty-keep-all',
                    totalClassifiedCount: suggestions.length,
                    kodyRulesSkippedCount: 0,
                    nonKodyInputCount: suggestions.length,
                    nonKodyOutputCount: suggestions.length,
                    finalOutputCount: suggestions.length,
                    uniqueCount: 0,
                    groupsCount: 0,
                    removedCount: 0,
                    unique: suggestions.map((suggestion) =>
                        deps.summarize(suggestion),
                    ),
                },
            };
        }

        const result: Partial<CodeSuggestion>[] = [];
        const uniqueSuggestions: DedupTraceSuggestionSummary[] = [];
        const groupSummaries: DedupTraceGroupSummary[] = [];
        const addedIndices = new Set<number>();
        const classifiedIndices = new Set<number>();
        const indexToResult = new Map<number, number>();

        // Layer 1: Number.isInteger guard — NaN and non-integer floats rejected immediately

        // Add unique suggestions as-is
        for (const idx of unique) {
            if (Number.isInteger(idx) && idx >= 0 && idx < suggestions.length) {
                indexToResult.set(idx, result.length);
                result.push(suggestions[idx]);
                addedIndices.add(idx);
                classifiedIndices.add(idx);
                uniqueSuggestions.push(deps.summarize(suggestions[idx]));
            }
        }

        // Process groups
        for (const group of groups) {
            const keepIdx = group.keep;
            const dupIndices = group.duplicates || [];

            if (
                !Number.isInteger(keepIdx) ||
                keepIdx < 0 ||
                keepIdx >= suggestions.length
            ) {
                // Layer 2: keep is invalid — preserve valid duplicates as independent results
                for (const dupIdx of dupIndices) {
                    classifiedIndices.add(dupIdx);
                    if (
                        Number.isInteger(dupIdx) &&
                        dupIdx >= 0 &&
                        dupIdx < suggestions.length &&
                        !addedIndices.has(dupIdx)
                    ) {
                        indexToResult.set(dupIdx, result.length);
                        result.push(suggestions[dupIdx]);
                        addedIndices.add(dupIdx);
                        uniqueSuggestions.push(
                            deps.summarize(suggestions[dupIdx]),
                        );
                    }
                }
                continue;
            }

            // Skip if this keep was already added (malformed groups with overlapping indices)
            if (addedIndices.has(keepIdx)) {
                // Merge duplicate locations into the already-added suggestion
                const existingIdx = indexToResult.get(keepIdx);
                if (existingIdx !== undefined) {
                    const locations: string[] = [];
                    for (const dupIdx of dupIndices) {
                        if (
                            Number.isInteger(dupIdx) &&
                            dupIdx >= 0 &&
                            dupIdx < suggestions.length
                        ) {
                            classifiedIndices.add(dupIdx);
                            const dup = suggestions[dupIdx];
                            // This branch absorbs duplicates without ever
                            // consulting the content guard, so the invariant
                            // has to be repeated here: two scanner findings
                            // are different categories, and absorbing one
                            // drops a whole category's comment.
                            if (bothFromAnalyzers(dup, suggestions[keepIdx])) {
                                if (!addedIndices.has(dupIdx)) {
                                    addedIndices.add(dupIdx);
                                    indexToResult.set(dupIdx, result.length);
                                    result.push(dup);
                                    uniqueSuggestions.push(deps.summarize(dup));
                                }
                                continue;
                            }
                            // No content guard on this branch, so a
                            // nested range may be a different bug: only
                            // the same location is left out of the list.
                            const loc = `${dup.relevantFile}:${dup.relevantLinesStart}-${dup.relevantLinesEnd}`;
                            const keptLoc = `${suggestions[keepIdx].relevantFile}:${suggestions[keepIdx].relevantLinesStart}-${suggestions[keepIdx].relevantLinesEnd}`;
                            if (loc !== keptLoc) {
                                locations.push(loc);
                            }
                        }
                    }
                    if (locations.length > 0) {
                        const existing = result[existingIdx];
                        existing.alsoFoundIn = [
                            ...new Set([
                                ...(existing.alsoFoundIn || []),
                                ...locations,
                            ]),
                        ];
                    }
                } else {
                    for (const dupIdx of dupIndices) {
                        if (
                            Number.isInteger(dupIdx) &&
                            dupIdx >= 0 &&
                            dupIdx < suggestions.length
                        ) {
                            classifiedIndices.add(dupIdx);
                        }
                    }
                }
                continue;
            }

            const kept = { ...suggestions[keepIdx] };
            addedIndices.add(keepIdx);
            classifiedIndices.add(keepIdx);
            const duplicateSummaries: DedupTraceSuggestionSummary[] = [];

            // Collect locations from duplicates that are in DIFFERENT locations
            const otherLocations: string[] = [];
            for (const dupIdx of dupIndices) {
                if (
                    !Number.isInteger(dupIdx) ||
                    dupIdx < 0 ||
                    dupIdx >= suggestions.length
                ) {
                    continue;
                }
                // Content guard: only honor the model's merge when the two
                // findings actually describe the same thing. A low word-overlap
                // "duplicate" is a DIFFERENT bug the model over-merged (distinct
                // issues on overlapping lines) — keep it instead of dropping.
                const decision = await deps.resolveMerge(
                    suggestions[dupIdx],
                    suggestions[keepIdx],
                    `n${dupIdx}`,
                    `n${keepIdx}`,
                    embedCache,
                    runTiebreak,
                    {
                        logMeta: {
                            prNumber,
                            organizationId: telemetryMeta?.organizationId,
                            teamId: telemetryMeta?.teamId,
                        },
                    },
                );
                if (!decision.honor) {
                    // The model grouped these as duplicates but the guard is
                    // not confident they are the same bug, so we keep both.
                    // Log it — otherwise this veto is invisible in production
                    // (the silent-degradation family from PR #1527).
                    deps.logger.log({
                        message: `[DEDUP-GUARD] PR#${prNumber}: merge of idx ${dupIdx} into ${keepIdx} rejected (${decision.reason}, score=${decision.score.toFixed(3)})`,
                        context: deps.context,
                    });
                    classifiedIndices.add(dupIdx);
                    if (!addedIndices.has(dupIdx)) {
                        addedIndices.add(dupIdx);
                        indexToResult.set(dupIdx, result.length);
                        result.push(suggestions[dupIdx]);
                        uniqueSuggestions.push(
                            deps.summarize(suggestions[dupIdx]),
                        );
                    }
                    continue;
                }
                classifiedIndices.add(dupIdx);
                const dup = suggestions[dupIdx];
                duplicateSummaries.push(deps.summarize(dup));
                // The content guard above judged these the same bug, so a
                // range around or inside the kept one is the same place,
                // not another location.
                if (!isSameSpot(dup, kept)) {
                    otherLocations.push(
                        `${dup.relevantFile}:${dup.relevantLinesStart}-${dup.relevantLinesEnd}`,
                    );
                }

                deps.logger.log({
                    message: `[DEDUP-REMOVED] PR#${prNumber} ${dup.relevantFile}:${dup.relevantLinesStart}-${dup.relevantLinesEnd} [${dup.label}/${dup.severity}] "${dup.oneSentenceSummary || dup.suggestionContent?.substring(0, 80)}"`,
                    context: deps.context,
                });
            }

            if (otherLocations.length > 0) {
                kept.alsoFoundIn = [
                    ...new Set([
                        ...(kept.alsoFoundIn || []),
                        ...otherLocations,
                    ]),
                ];
            }

            groupSummaries.push({
                keep: deps.summarize(kept),
                duplicates: duplicateSummaries,
            });
            indexToResult.set(keepIdx, result.length);
            result.push(kept);
        }

        // Layer 3: Safety net — add any suggestions not classified by dedup
        // (neither in unique nor in any group's keep/duplicates). This handles
        // malformed LLM output that omits some indices entirely.
        for (let i = 0; i < suggestions.length; i++) {
            if (!classifiedIndices.has(i)) {
                result.push(suggestions[i]);
                uniqueSuggestions.push(deps.summarize(suggestions[i]));
            }
        }

        const totalRemoved = suggestions.length - result.length;
        if (totalRemoved > 0) {
            deps.logger.log({
                message: `[DEDUP] PR#${prNumber}: ${suggestions.length} → ${result.length} (removed ${totalRemoved} duplicates, ${groups.length} groups merged)`,
                context: deps.context,
            });
        }

        return {
            suggestions: result,
            trace: {
                status: 'success',
                totalClassifiedCount: suggestions.length,
                kodyRulesSkippedCount: 0,
                nonKodyInputCount: suggestions.length,
                nonKodyOutputCount: result.length,
                finalOutputCount: result.length,
                uniqueCount: uniqueSuggestions.length,
                groupsCount: groupSummaries.length,
                removedCount: totalRemoved,
                ...(followupError ? { followupError } : {}),
                groups: groupSummaries,
                unique: uniqueSuggestions,
            },
        };
    } catch (error) {
        // Fail loud outside production. An unexpected error here (e.g. the
        // `googleKey` ReferenceError that shipped on a feature branch) is a
        // programming bug — left to the graceful 'failed-keep-all' path it
        // ships silently as duplicate comments. In dev/CI/test we re-throw so
        // it surfaces at PR time. The operational "no model available" case is
        // handled BEFORE LLM.run by the `dedupSlot`/managed-key guard above,
        // so it never reaches this catch.
        const isProduction =
            (process.env.API_NODE_ENV || process.env.NODE_ENV) === 'production';
        if (!isProduction) {
            throw error;
        }
        deps.logger.error({
            message: `[DEDUP] PR#${prNumber}: Failed, keeping all ${suggestions.length} suggestions`,
            context: deps.context,
            error,
        });
        return {
            suggestions,
            trace: {
                status: 'failed-keep-all',
                totalClassifiedCount: suggestions.length,
                kodyRulesSkippedCount: 0,
                nonKodyInputCount: suggestions.length,
                nonKodyOutputCount: suggestions.length,
                finalOutputCount: suggestions.length,
                uniqueCount: suggestions.length,
                groupsCount: 0,
                removedCount: 0,
                errorMessage:
                    error instanceof Error ? error.message : String(error),
                unique: suggestions.map((suggestion) =>
                    deps.summarize(suggestion),
                ),
            },
        };
    }
}

/**
 * The default wiring for a caller that is not the review stage: the
 * standalone helpers above, logging under `context`, and its own embedder.
 *
 * Embedder for the dedup semantic tier. HARDCODED to OpenAI: text-embedding
 * models are OpenAI's, so this must NEVER go through the client's BYOK
 * provider nor inherit a forced base URL (e.g. a Moonshot/OpenAI-compatible
 * override in the env) — those don't serve text-embedding-3-small. The
 * base URL is pinned explicitly; only the platform key comes from the env.
 * (The tiebreak LLM that runs AFTER the embedding still uses BYOK.) Built
 * lazily, once per deps object; the embedding cache is per dedup run.
 */
export function createFindingDedupDeps(
    params: FindingDedupLog,
): FindingDedupDeps {
    const log: FindingDedupLog = {
        logger: params.logger,
        context: params.context,
    };
    let embedder: EmbeddingModel | null | undefined;
    const getEmbedder = (): EmbeddingModel | null => {
        if (embedder !== undefined) {
            return embedder;
        }
        // Single platform-embedder seam (libs/common/utils/document): pinned to
        // OpenAI text-embedding, never BYOK, null when no platform key.
        embedder = buildPlatformEmbedder();
        return embedder;
    };
    const embedDeps = {
        embed: (
            suggestion: Partial<CodeSuggestion>,
            key: string,
            cache: DedupEmbedCache,
            logMeta?: DedupLogMeta,
        ) =>
            embedDedupSuggestion(
                { ...log, getEmbedder },
                suggestion,
                key,
                cache,
                logMeta,
            ),
    };
    return {
        ...log,
        summarize: summarizeDedupSuggestion,
        resolveMerge: (
            dup,
            keep,
            dupKey,
            keepKey,
            embedCache,
            tiebreak,
            opts,
        ) =>
            resolveDedupMerge(
                embedDeps,
                dup,
                keep,
                dupKey,
                keepKey,
                embedCache,
                tiebreak,
                opts,
            ),
        buildTiebreak: (byokConfig, telemetryMeta, prNumber) =>
            buildDedupTiebreak(log, byokConfig, telemetryMeta, prNumber),
    };
}
