/**
 * code-review (domain) — chunked (multi-batch) review runner.
 *
 * Phase 5 of the provider decomposition. When a PR's diff exceeds the model's
 * context budget, the review is split into token-budget batches and each is run
 * independently, then aggregated. Extracted from BaseCodeReviewAgentProvider:
 * the per-batch execution is injected as `runBatch` (the provider passes its own
 * execute()), so this carries no `this`.
 */
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import type { ReviewWarning } from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import type {
    ReviewAgentIdentity,
    ReviewAgentInput,
    ReviewAgentOutput,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';
import {
    chunkFilesByTokenBudget,
    estimateDiffTokens,
} from '@libs/code-review/infrastructure/agents/collaborators/context-fit-planner';

export interface BatchRunnerDeps {
    identity: ReviewAgentIdentity;
    agentCategory: string;
    startTime: number;
    diffBudget: number;
    parentWarnings?: ReviewWarning[];
    /** Runs a single batch — the provider passes its own execute(). */
    runBatch: (batchInput: ReviewAgentInput) => Promise<ReviewAgentOutput>;
    logger: { log: (e: any) => void; error: (e: any) => void };
}

/**
 * Runs the agent in multiple batches when the total diff size exceeds the
 * model's context window budget. Each batch gets a subset of files with their
 * full diffs; results are aggregated. If every batch fails (and nothing was
 * collected) the first error is propagated so the orchestrator records a failure.
 */
export async function runChunkedReview(
    input: ReviewAgentInput,
    deps: BatchRunnerDeps,
): Promise<ReviewAgentOutput> {
    const { identity, agentCategory, startTime, diffBudget, parentWarnings } =
        deps;
    const logger = deps.logger;
        const chunks = chunkFilesByTokenBudget(input.changedFiles, diffBudget);

        if (
            chunks.length === 1 &&
            chunks[0].length === input.changedFiles.length &&
            input.changedFiles.length > 1
        ) {
            logger.log({
                message: `[AGENT] ${identity.name} chunker returned 1 chunk for ${input.changedFiles.length} files (files pack comfortably); proceeding as single batch`,
                context: identity.name,
                metadata: {
                    prNumber: input.prNumber,
                    filesCount: input.changedFiles.length,
                    diffBudget,
                },
            });
        }

        logger.log({
            message: `[AGENT] ${identity.name} PR#${input.prNumber}: reviewing ${input.changedFiles.length} files in ${chunks.length} batch(es)`,
            context: identity.name,
            metadata: {
                batches: chunks.map((c, i) => ({
                    batch: i + 1,
                    files: c.length,
                    tokens: estimateDiffTokens(c),
                })),
            },
        });

        const allSuggestions: Partial<CodeSuggestion>[] = [];
        const allDiscardedBySeverity: Partial<CodeSuggestion>[] = [];
        const allDiscardedByVerify: Partial<CodeSuggestion>[] = [];
        const allWarnings: ReviewWarning[] = [...(parentWarnings ?? [])];
        let totalTurns = 0;
        const batchErrors: Error[] = [];

        const batchTotal = chunks.length;

        for (let i = 0; i < batchTotal; i++) {
            const batchFiles = chunks[i];
            const batchIndex = i + 1;
            const batchLabel = `${identity.name} batch ${batchIndex}/${batchTotal}`;
            const batchStartedAt = Date.now();

            logger.log({
                message: `[AGENT] ${batchLabel} starting: ${batchFiles.length} files`,
                context: identity.name,
                metadata: { files: batchFiles.map((f) => f.filename) },
            });

            // Surface batch boundaries in the PR logs UI so users can see
            // the review is chunked (otherwise the per-step counter appears
            // to "reset" between batches with no explanation).
            input.onAgentProgress?.({
                agentName: identity.name,
                agentCategory,
                agentReplicaIndex: input.agentReplicaIndex,
                agentReplicaTotal: input.agentReplicaTotal,
                status: 'batch_started',
                batchIndex,
                batchTotal,
                batchFiles: batchFiles.length,
            });

            try {
                const batchInput: ReviewAgentInput = {
                    ...input,
                    changedFiles: batchFiles,
                    agentRuntimeName: batchLabel,
                    // Forward batch info so per-step events emitted inside
                    // execute() can include it in their labels.
                    batchIndex,
                    batchTotal,
                    // Increment the recursion counter so the depth guard in
                    // execute() can short-circuit any unexpected re-entry.
                    recursionDepth: (input.recursionDepth ?? 0) + 1,
                };

                const batchResult = await deps.runBatch(batchInput);

                allSuggestions.push(...batchResult.suggestions);
                if (batchResult.discardedBySeverity) {
                    allDiscardedBySeverity.push(
                        ...batchResult.discardedBySeverity,
                    );
                }
                if (batchResult.discardedByVerify) {
                    allDiscardedByVerify.push(...batchResult.discardedByVerify);
                }
                if (batchResult.warnings?.length) {
                    allWarnings.push(...batchResult.warnings);
                }
                totalTurns += batchResult.turnsUsed;

                logger.log({
                    message: `[AGENT] ${batchLabel} completed: ${batchResult.suggestions.length} findings`,
                    context: identity.name,
                });

                input.onAgentProgress?.({
                    agentName: identity.name,
                    agentCategory,
                    agentReplicaIndex: input.agentReplicaIndex,
                    agentReplicaTotal: input.agentReplicaTotal,
                    status: 'batch_completed',
                    batchIndex,
                    batchTotal,
                    batchFiles: batchFiles.length,
                    findings: batchResult.suggestions.length,
                    durationMs: Date.now() - batchStartedAt,
                });
            } catch (error) {
                const errMsg =
                    error instanceof Error ? error.message : String(error);
                const errName = error instanceof Error ? error.name : undefined;
                logger.error({
                    message: `[AGENT] ${batchLabel} failed: ${errMsg}`,
                    context: identity.name,
                    error,
                });

                input.onAgentProgress?.({
                    agentName: identity.name,
                    agentCategory,
                    agentReplicaIndex: input.agentReplicaIndex,
                    agentReplicaTotal: input.agentReplicaTotal,
                    status: 'error',
                    batchIndex,
                    batchTotal,
                    batchFiles: batchFiles.length,
                    durationMs: Date.now() - batchStartedAt,
                    errorMessage: errMsg.substring(0, 500),
                    errorName: errName,
                });

                batchErrors.push(
                    error instanceof Error ? error : new Error(errMsg),
                );
            }
        }

        // When every batch failed, propagate the first batch's error so
        // the orchestrator records the agent as failed (failures[]) and
        // the end-review comment shows the friendly reason. Partial
        // failures still return whatever findings we did collect — those
        // are real signal even if some batches couldn't complete.
        if (
            batchErrors.length === batchTotal &&
            batchTotal > 0 &&
            allSuggestions.length === 0
        ) {
            logger.error({
                message: `[AGENT] ${identity.name} PR#${input.prNumber}: all ${batchTotal} batches failed; propagating first batch error to orchestrator`,
                context: identity.name,
                metadata: {
                    prNumber: input.prNumber,
                    batchTotal,
                    firstError: batchErrors[0]?.message,
                },
            });
            throw batchErrors[0];
        }

        const durationMs = Date.now() - startTime;

        logger.log({
            message: `[AGENT] ${identity.name} PR#${input.prNumber} all batches done: ${allSuggestions.length} total findings in ${durationMs}ms`,
            context: identity.name,
        });

        input.onAgentProgress?.({
            agentName: identity.name,
            agentCategory,
            agentReplicaIndex: input.agentReplicaIndex,
            agentReplicaTotal: input.agentReplicaTotal,
            status: 'completed',
            findings: allSuggestions.length,
            durationMs,
        });

        return {
            suggestions: allSuggestions,
            discardedBySeverity: allDiscardedBySeverity,
            discardedByVerify: allDiscardedByVerify,
            agentName: identity.name,
            agentCategory,
            agentReplicaIndex: input.agentReplicaIndex,
            agentReplicaTotal: input.agentReplicaTotal,
            turnsUsed: totalTurns,
            durationMs,
            warnings: allWarnings,
        };
}
