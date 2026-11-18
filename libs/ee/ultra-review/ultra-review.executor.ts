/**
 * Enterprise Code — see `license_ee.md`. An Ultra review: the heavy review on
 * each of the org's three models, merged into one set of comments.
 */
import type {
    CodeReviewPipelineContext,
    DedupTraceSummary,
} from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import type {
    ReviewPass,
    ReviewPassCollected,
} from '@libs/code-review/pipeline/stages/agent-review.stage';
import type {
    UltraModel,
    UltraReviewState,
} from '@libs/code-review/domain/ultra-review-state';
import type { CustomAgentsById } from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-presentation';
import {
    dedupReviewWarnings,
    type ReviewWarning,
} from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import type { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { createLogger } from '@libs/core/log/logger';
import type { NormalizedModel } from '@libs/llm/byok-config';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import {
    runUltraModels,
    ultraReviewOutcome,
} from './ultra-review-runner';

const logger = createLogger('UltraReview');

/** Why an Ultra review that did not run as configured holds approval. */
export const ULTRA_REVIEW_DEGRADED_REASON = 'ULTRA_REVIEW_DEGRADED';

/** The timeline entry of the cross-model merge. */
export const ULTRA_MERGE_STAGE_NAME = 'AgentReview::ultra-merge';

/** What AgentReviewStage lends an Ultra review. */
export interface UltraReviewHost {
    reviewPass(
        context: CodeReviewPipelineContext,
        pass: ReviewPass,
    ): Promise<CodeReviewPipelineContext>;
    /** A sandbox of the run's own, or undefined (the run goes without). */
    acquireRunSandbox(
        context: CodeReviewPipelineContext,
        suffix: string,
    ): Promise<SandboxInstance | undefined>;
    /** The context a model's run reviews in: its sandbox, its model. */
    runContext(
        context: CodeReviewPipelineContext,
        model: UltraModel,
        sandbox: SandboxInstance | undefined,
    ): CodeReviewPipelineContext;
    update(
        context: CodeReviewPipelineContext,
        recipe: (draft: CodeReviewPipelineContext) => void,
    ): CodeReviewPipelineContext;
    /** The production dedup of non-rule findings, on `slot`. */
    mergeFindings(
        findings: Partial<CodeSuggestion>[],
        prNumber: number,
        slot: NormalizedModel,
        context: CodeReviewPipelineContext,
    ): Promise<{
        suggestions: Partial<CodeSuggestion>[];
        trace: DedupTraceSummary;
    }>;
    crossDedupStreams(
        nonRules: Partial<CodeSuggestion>[],
        kodyRules: Partial<CodeSuggestion>[],
        prNumber: number,
        context: CodeReviewPipelineContext,
    ): Promise<Partial<CodeSuggestion>[]>;
    customAgentsById(
        context: CodeReviewPipelineContext,
    ): Promise<CustomAgentsById>;
    publishFindings(
        context: CodeReviewPipelineContext,
        input: {
            deduped: Partial<CodeSuggestion>[];
            allDiscarded: Partial<CodeSuggestion>[];
            customAgentsById: CustomAgentsById;
            customAgentRuns: ReviewPassCollected['customAgentRuns'];
            mergedInDedup: Partial<CodeSuggestion>[];
            dedupTrace: DedupTraceSummary;
            changedFiles: NonNullable<CodeReviewPipelineContext['changedFiles']>;
            prNumber: number;
        },
    ): CodeReviewPipelineContext;
    recordTimeline(
        context: CodeReviewPipelineContext,
        entry: {
            stageName: string;
            label: string;
            status: AutomationStatus;
            metadata?: Record<string, unknown>;
        },
    ): Promise<void>;
}

const runSuffix = (model: UltraModel) =>
    model.position === 'fallback'
        ? 'ultra-fallback'
        : `ultra-${model.position}`;

/** Whether the auxiliary agents have anything to run on. */
function hasAuxiliaryWork(context: CodeReviewPipelineContext): boolean {
    return (
        (context.codeReviewConfig?.kodyRules?.length ?? 0) > 0 ||
        (context.codeReviewConfig?.customAgents?.length ?? 0) > 0 ||
        (context.analyzerFindings?.length ?? 0) > 0
    );
}

const emptyCollected = (): ReviewPassCollected => ({
    findings: [],
    discarded: [],
    mergedInDedup: [],
    completion: { completed: true },
});

/**
 * The cross-model merge: the production dedup on the merge model, then on the
 * org fallback; with both failing, the findings go out unmerged.
 */
async function mergeAcrossModels(
    host: UltraReviewHost,
    context: CodeReviewPipelineContext,
    findings: Partial<CodeSuggestion>[],
    prNumber: number,
    state: UltraReviewState,
    modelLists: number,
    logMeta: Record<string, unknown>,
): Promise<{
    merged: Partial<CodeSuggestion>[];
    trace?: DedupTraceSummary;
    merge: NonNullable<UltraReviewState['merge']>;
}> {
    const inputCount = findings.length;
    const skipped = modelLists < 2;
    if (inputCount <= 1) {
        return {
            merged: findings,
            merge: {
                status: skipped ? 'skipped' : 'success',
                modelName: state.mergeModel.modelName,
                inputCount,
                outputCount: inputCount,
            },
        };
    }

    const candidates: Array<{ model: UltraModel; status: 'success' | 'fallback' }> = [
        { model: state.mergeModel, status: 'success' },
    ];
    if (state.fallback && state.fallback.modelId !== state.mergeModel.modelId) {
        candidates.push({ model: state.fallback, status: 'fallback' });
    }

    let lastError = '';
    for (const { model, status } of candidates) {
        try {
            const result = await host.mergeFindings(
                findings,
                prNumber,
                model.slot,
                context,
            );
            const failed =
                result.trace.status === 'failed-keep-all' ||
                result.trace.status === 'empty-keep-all';
            if (!failed) {
                return {
                    merged: result.suggestions,
                    trace: result.trace,
                    merge: {
                        status: skipped ? 'skipped' : status,
                        modelName: model.modelName,
                        inputCount,
                        outputCount: result.suggestions.length,
                    },
                };
            }
            lastError =
                result.trace.errorMessage ??
                'The merge model returned no answer.';
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        logger.warn({
            message: `[ULTRA] The merge failed on ${model.modelName}`,
            context: 'UltraReview',
            metadata: { ...logMeta, model: model.modelName, error: lastError },
        });
    }
    return {
        merged: findings,
        merge: {
            status: skipped ? 'skipped' : 'failed',
            inputCount,
            outputCount: inputCount,
            errorMessage: lastError,
        },
    };
}

/**
 * Runs the Ultra review: the heavy review on each model in parallel, each in
 * its own sandbox and with that model forced on every step, one fallback for
 * the whole review; Kody Rules and the custom agents once, on their routed
 * models; then one cross-model merge and the comments. Publishes when at
 * least one model completed; a review that did not run as configured carries
 * a partial error, which holds automatic approval and posts the notice.
 */
export async function executeUltraReview(
    context: CodeReviewPipelineContext,
    host: UltraReviewHost,
): Promise<CodeReviewPipelineContext> {
    const changedFiles = context.changedFiles ?? [];
    // Only ignored files changed: no model reviews them, the custom agents do.
    if (!changedFiles.length) {
        return host.reviewPass(context, {});
    }
    const state = context.ultra!;
    const prNumber = context.pullRequest?.number;
    const logMeta = {
        organizationId: context.organizationAndTeamData?.organizationId,
        teamId: context.organizationAndTeamData?.teamId,
        prNumber,
        repositoryId: context.repository?.id,
    };
    logger.log({
        message: `[ULTRA] PR#${prNumber}: reviewing on ${state.models.map((m) => m.modelName).join(', ')}; fallback ${state.fallback?.modelName ?? 'none'}; merge on ${state.mergeModel.modelName}`,
        context: 'UltraReview',
        metadata: {
            ...logMeta,
            models: state.models.map((m) => m.modelName),
            unavailable: state.unavailable?.map((u) => u.modelId),
            fallback: state.fallback?.modelName,
            mergeModel: state.mergeModel.modelName,
        },
    });

    // Kody Rules and the custom agents, once, on the PR's own sandbox, which
    // is released as soon as they are done: the models have their own.
    let auxiliary = emptyCollected();
    const auxiliaryRun = (
        hasAuxiliaryWork(context)
            ? host.reviewPass(context, {
                  scope: 'auxiliary',
                  collect: (collected) => {
                      auxiliary = collected;
                  },
              })
            : Promise.resolve(context)
    ).finally(() => context.sandboxHandle?.cleanup?.().catch(() => undefined));

    const runWarnings: ReviewWarning[] = [];
    const runErrors: CodeReviewPipelineContext['lastReviewError'][] = [];
    const { runs, outputs } = await runUltraModels<ReviewPassCollected>({
        state,
        run: async (model) => {
            const suffix = runSuffix(model);
            const sandbox = await host.acquireRunSandbox(context, suffix);
            try {
                let collected: ReviewPassCollected | undefined;
                const after = await host.reviewPass(
                    host.runContext(context, model, sandbox),
                    {
                        scope: 'native',
                        model,
                        timelineTag: { key: suffix, label: model.modelName },
                        collect: (c) => {
                            collected = c;
                        },
                    },
                );
                runWarnings.push(...(after.reviewWarnings ?? []));
                if (after.lastReviewError) runErrors.push(after.lastReviewError);
                if (!collected) {
                    return {
                        completed: false,
                        failureReason: 'The review ended without its findings.',
                    };
                }
                logger.log({
                    message: `[ULTRA] PR#${prNumber}: ${model.modelName} ${collected.completion.completed ? 'completed' : 'failed'} with ${collected.findings.length} findings`,
                    context: 'UltraReview',
                    metadata: {
                        ...logMeta,
                        model: model.modelName,
                        position: model.position,
                        completed: collected.completion.completed,
                        failureReason: collected.completion.failureReason,
                        findings: collected.findings.length,
                    },
                });
                return {
                    completed: collected.completion.completed,
                    failureReason: collected.completion.failureReason,
                    output: collected,
                    findings: collected.findings.length,
                };
            } finally {
                await sandbox?.cleanup?.().catch(() => undefined);
            }
        },
    });

    let main = await auxiliaryRun;

    const nativeFindings = outputs.flatMap((o) => o.output.findings);
    const auxRules = auxiliary.findings.filter((s) => s.label === 'kody_rules');
    const auxOthers = auxiliary.findings.filter(
        (s) => s.label !== 'kody_rules',
    );
    const { merged, trace, merge } = await mergeAcrossModels(
        host,
        main,
        [...nativeFindings, ...auxOthers],
        prNumber,
        state,
        outputs.length,
        logMeta,
    );
    await host.recordTimeline(main, {
        stageName: ULTRA_MERGE_STAGE_NAME,
        label:
            merge.status === 'failed'
                ? `Cross-model merge — failed, ${merge.inputCount} comments posted unmerged`
                : `Cross-model merge · ${merge.modelName} — ${merge.inputCount} → ${merge.outputCount} comments`,
        status:
            merge.status === 'failed'
                ? AutomationStatus.ERROR
                : AutomationStatus.SUCCESS,
        metadata: { merge },
    });

    const deduped = await host.crossDedupStreams(
        merged,
        auxRules,
        prNumber,
        main,
    );

    const outcome = ultraReviewOutcome(runs, merge);
    const finalState: UltraReviewState = { ...state, runs, merge, outcome };
    logger.log({
        message: `[ULTRA] PR#${prNumber}: ${outcome}; ${runs.filter((r) => r.status === 'completed').length} runs completed; merge ${merge.status} (${merge.inputCount} → ${merge.outputCount})`,
        context: 'UltraReview',
        metadata: { ...logMeta, outcome, runs, merge },
    });

    main = host.update(main, (draft) => {
        draft.ultra = finalState;
        const warnings = dedupReviewWarnings([
            ...(draft.reviewWarnings ?? []),
            ...runWarnings,
        ]);
        if (warnings.length) draft.reviewWarnings = warnings;
        if (outcome === 'success') return;
        if (!draft.errors) draft.errors = [];
        const failed = runs
            .filter((r) => r.status === 'failed')
            .map((r) => `${r.modelName}: ${r.failureReason}`)
            .join('; ');
        draft.errors.push({
            pipelineId: context.pipelineMetadata?.pipelineId,
            stage: 'AgentReviewStage',
            substage: 'ultra',
            error: new Error(
                outcome === 'failed'
                    ? `No Ultra review model completed (${failed})`
                    : `Ultra review did not run as configured${failed ? ` (${failed})` : ''}${merge.status === 'failed' ? '; the merge failed' : ''}`,
            ),
            severity: outcome === 'failed' ? 'critical' : 'partial',
            metadata: {
                prNumber,
                reason: ULTRA_REVIEW_DEGRADED_REASON,
                outcome,
            },
        });
        if (outcome === 'failed' && !draft.lastReviewError && runErrors[0]) {
            draft.lastReviewError = runErrors[0];
        }
    });

    return host.publishFindings(main, {
        deduped,
        allDiscarded: [
            ...auxiliary.discarded,
            ...outputs.flatMap((o) => o.output.discarded),
        ],
        customAgentsById: await host.customAgentsById(main),
        customAgentRuns: auxiliary.customAgentRuns,
        mergedInDedup: auxiliary.mergedInDedup,
        dedupTrace:
            trace ??
            auxiliary.dedupTrace ?? {
                status: 'skipped',
                totalClassifiedCount: deduped.length,
                kodyRulesSkippedCount: auxRules.length,
                nonKodyInputCount: merge.inputCount,
                nonKodyOutputCount: merge.outputCount,
                finalOutputCount: deduped.length,
                uniqueCount: merge.outputCount,
                groupsCount: 0,
                removedCount: 0,
                unique: [],
            },
        changedFiles,
        prNumber,
    });
}
