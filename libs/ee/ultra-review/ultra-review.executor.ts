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
    OTHER_LOCATIONS_HEADING,
    otherLocationsToRender,
} from '@libs/code-review/infrastructure/agents/engine/kody-rules-merge';
import {
    dedupReviewWarnings,
    type ReviewWarning,
} from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import type { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { createLogger } from '@libs/core/log/logger';
import { randomUUID } from 'node:crypto';
import type { NormalizedModel } from '@libs/llm/byok-config';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { runUltraModels, ultraReviewOutcome } from './ultra-review-runner';

const logger = createLogger('UltraReview');

/** Why an Ultra review that did not run as configured holds approval. */
export const ULTRA_REVIEW_DEGRADED_REASON = 'ULTRA_REVIEW_DEGRADED';

/** The timeline entry of the cross-model merge. */
export const ULTRA_MERGE_STAGE_NAME = 'AgentReview::ultra-merge';

/**
 * The time an Ultra review spends, sized so the comments go out before the
 * review job's own ceiling (105 min) kills it and loses what was done.
 */
export interface UltraReviewLimits {
    /** A model's review loop is stopped after this long. */
    runDeadlineMs: number;
    /** After its loop stops, how long a run gets to finish its later steps. */
    runGraceMs: number;
    /** Every run, the fallback included, ends this long after the start. */
    runsWindowMs: number;
    /** The fallback starts only with at least this long to review. */
    fallbackMinMs: number;
    /** Each merge attempt is dropped after this long. */
    mergeDeadlineMs: number;
}

// Model runs end by minute 75 at the latest; two merge attempts take at most
// 16 more, which leaves the cross-dedup and the comments well inside 105.
export const ULTRA_REVIEW_LIMITS: UltraReviewLimits = {
    runDeadlineMs: 40 * 60 * 1000,
    runGraceMs: 10 * 60 * 1000,
    runsWindowMs: 75 * 60 * 1000,
    fallbackMinMs: 15 * 60 * 1000,
    mergeDeadlineMs: 8 * 60 * 1000,
};

/** A run's sandbox outlives the longest the run can take. */
export const ULTRA_RUN_LEASE_TTL_MS =
    ULTRA_REVIEW_LIMITS.runsWindowMs + 5 * 60 * 1000;

const minutes = (ms: number) => Math.round(ms / 60_000);

const TIMED_OUT = Symbol('timed out');

/** The value of `promise`, or TIMED_OUT when it takes longer than `ms`. */
async function withDeadline<T>(
    promise: Promise<T>,
    ms: number,
): Promise<T | typeof TIMED_OUT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
    });
    try {
        return await Promise.race([promise, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/** A signal that fires with `parent` or after `ms`. */
function deadlineSignal(
    parent: AbortSignal | undefined,
    ms: number,
): { signal: AbortSignal; clear: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return {
        signal: parent
            ? AbortSignal.any([parent, controller.signal])
            : controller.signal,
        clear: () => clearTimeout(timer),
    };
}

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
        leaseTtlMs: number,
        /** Stops waiting for a sandbox slot: the run's deadline. */
        signal: AbortSignal,
    ): Promise<SandboxInstance | undefined>;
    /**
     * The context a model's run reviews in: its sandbox, its model, and the
     * signal that stops its review loop.
     */
    runContext(
        context: CodeReviewPipelineContext,
        model: UltraModel,
        sandbox: SandboxInstance | undefined,
        signal: AbortSignal,
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
            changedFiles: NonNullable<
                CodeReviewPipelineContext['changedFiles']
            >;
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

/** A run's tag on the timeline: its place in the trio. */
const runTag = (model: UltraModel) =>
    model.position === 'fallback'
        ? 'ultra-fallback'
        : `ultra-${model.position}`;

/**
 * A tag of this review alone, on its runs' sandbox keys: a review started by
 * a later push never joins, or inherits the lease of, this one's sandboxes.
 */
function reviewSandboxTag(context: CodeReviewPipelineContext): string {
    const fromPipeline = String(context.pipelineMetadata?.pipelineId ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 12);
    return fromPipeline || randomUUID().replace(/-/g, '').slice(0, 12);
}

const otherLocationsSection = (locations: string[]) =>
    `\n\n${OTHER_LOCATIONS_HEADING}\n${locations.map((l) => `- \`${l}\``).join('\n')}`;

/**
 * Each run listed its own comments' other locations; the merge across models
 * and the dedup against Kody Rules add the places a kept comment absorbed.
 * The list is rewritten in the body, the explanation and the prompt, so the
 * developer sees every place to fix.
 */
function renderLocationsAddedAfterRuns(
    findings: Partial<CodeSuggestion>[],
    renderedBefore: (finding: Partial<CodeSuggestion>) => string[],
): void {
    for (const finding of findings) {
        const before = renderedBefore(finding);
        const after = otherLocationsToRender(finding);
        if (after.every((l) => before.includes(l))) continue;
        const previous = before.length ? otherLocationsSection(before) : '';
        const next = otherLocationsSection(after);
        const rewrite = (text: string) =>
            previous && text.includes(previous)
                ? text.replace(previous, next)
                : `${text}${next}`;
        finding.suggestionContent = rewrite(finding.suggestionContent || '');
        if (finding.fullExplanation) {
            finding.fullExplanation = rewrite(finding.fullExplanation);
        }
        if (finding.llmPrompt) finding.llmPrompt = rewrite(finding.llmPrompt);
    }
}

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
 * org fallback; with both failing, the findings go out unmerged. `streams`
 * counts the lists merged: each model's, and the custom agents'.
 */
async function mergeAcrossModels(
    host: UltraReviewHost,
    context: CodeReviewPipelineContext,
    findings: Partial<CodeSuggestion>[],
    prNumber: number,
    state: UltraReviewState,
    streams: number,
    logMeta: Record<string, unknown>,
    deadlineMs: number,
): Promise<{
    merged: Partial<CodeSuggestion>[];
    trace?: DedupTraceSummary;
    merge: NonNullable<UltraReviewState['merge']>;
}> {
    const inputCount = findings.length;
    // One list alone was deduplicated by its own run: nothing to merge.
    const skipped = streams < 2;
    if (skipped || inputCount <= 1) {
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

    const candidates: Array<{
        model: UltraModel;
        status: 'success' | 'fallback';
    }> = [{ model: state.mergeModel, status: 'success' }];
    if (state.fallback && state.fallback.modelId !== state.mergeModel.modelId) {
        candidates.push({ model: state.fallback, status: 'fallback' });
    }

    let lastError = '';
    for (const { model, status } of candidates) {
        try {
            const attempt = await withDeadline(
                host.mergeFindings(findings, prNumber, model.slot, context),
                deadlineMs,
            );
            if (attempt === TIMED_OUT) {
                throw new Error(
                    `The merge did not finish within ${minutes(deadlineMs)} minutes.`,
                );
            }
            const result = attempt;
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
    limits: UltraReviewLimits = ULTRA_REVIEW_LIMITS,
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

    const startedAt = Date.now();
    const runsEndAt = startedAt + limits.runsWindowMs;
    // A run's review loop gets the deadline or what is left of the window,
    // keeping the grace its later steps need.
    const runWindow = () =>
        Math.min(
            limits.runDeadlineMs,
            runsEndAt - Date.now() - limits.runGraceMs,
        );

    // Kody Rules and the custom agents, once, on the PR's own sandbox, which
    // is released as soon as they are done: the models have their own. They
    // stop with the models; past the window the review goes on without them.
    let auxiliary = emptyCollected();
    const releaseFailed = (sandbox: string) => (error: unknown) =>
        logger.warn({
            message: `[ULTRA] PR#${prNumber}: could not release the ${sandbox} sandbox; the lease reaper will`,
            context: 'UltraReview',
            error: error instanceof Error ? error : new Error(String(error)),
            metadata: logMeta,
        });
    const releaseBase = () =>
        context.sandboxHandle?.cleanup?.().catch(releaseFailed('PR'));
    const sandboxTag = reviewSandboxTag(context);
    // The PR's own review had a checkout: a model's run without one did
    // not review the repository and does not count as complete.
    const checkoutExpected = !!context.sandboxHandle;
    let auxiliaryRun: Promise<CodeReviewPipelineContext> =
        Promise.resolve(context);
    if (hasAuxiliaryWork(context)) {
        const stop = deadlineSignal(context.parentSignal, runWindow());
        let abandoned = false;
        auxiliaryRun = withDeadline(
            host
                .reviewPass(
                    host.update(context, (draft) => {
                        draft.parentSignal = stop.signal;
                    }),
                    {
                        scope: 'auxiliary',
                        collect: (collected) => {
                            if (!abandoned) auxiliary = collected;
                        },
                    },
                )
                .finally(() => {
                    stop.clear();
                    void releaseBase();
                }),
            runsEndAt - Date.now(),
        ).then((result) => {
            if (result !== TIMED_OUT) return result;
            abandoned = true;
            void releaseBase();
            logger.warn({
                message: `[ULTRA] PR#${prNumber}: Kody Rules and custom agents did not finish in time; the review goes on without them`,
                context: 'UltraReview',
                metadata: logMeta,
            });
            return context;
        });
    } else {
        void releaseBase();
    }

    const runWarnings: ReviewWarning[] = [];
    const runErrors: CodeReviewPipelineContext['lastReviewError'][] = [];
    const { runs, outputs } = await runUltraModels<ReviewPassCollected>({
        state,
        logMeta,
        fallbackAllowed: () => runWindow() >= limits.fallbackMinMs,
        run: async (model) => {
            const tag = runTag(model);
            const window = runWindow();
            const startedAt = Date.now();
            // The deadline covers the wait for a sandbox slot too: a run
            // that waits past it reviews with what time is left, or none.
            const stop = deadlineSignal(context.parentSignal, window);
            // A review a later push superseded takes no new sandboxes.
            const sandbox = context.sandboxSuperseded
                ? undefined
                : await host.acquireRunSandbox(
                      context,
                      `${tag}-${sandboxTag}`,
                      ULTRA_RUN_LEASE_TTL_MS,
                      stop.signal,
                  );
            const release = () =>
                sandbox?.cleanup?.().catch(releaseFailed(tag));
            const left = Math.max(0, window - (Date.now() - startedAt));
            // Whether the deadline stopped the review loop. Read when the loop
            // ends: the later steps have the grace, and a deadline that fires
            // during them stops nothing.
            let loopStopped: boolean | undefined;
            // A run that outlives its grace is left behind: nothing it
            // reports afterwards reaches the review.
            let abandoned = false;
            let collected: ReviewPassCollected | undefined;
            const pass = host
                .reviewPass(
                    host.runContext(context, model, sandbox, stop.signal),
                    {
                        scope: 'native',
                        model,
                        timelineTag: { key: tag, label: model.modelName },
                        onLoopEnd: () => {
                            loopStopped =
                                stop.signal.aborted &&
                                !context.parentSignal?.aborted;
                            stop.clear();
                        },
                        collect: (c) => {
                            if (!abandoned) collected = c;
                        },
                    },
                )
                .finally(() => {
                    stop.clear();
                    void release();
                });
            const result = await withDeadline(pass, left + limits.runGraceMs);
            if (result === TIMED_OUT) {
                abandoned = true;
                void release();
                logger.warn({
                    message: `[ULTRA] PR#${prNumber}: ${model.modelName} did not finish in time; left behind`,
                    context: 'UltraReview',
                    metadata: {
                        ...logMeta,
                        model: model.modelName,
                        position: model.position,
                    },
                });
                return {
                    completed: false,
                    failureReason: `It did not finish within ${minutes(window + limits.runGraceMs)} minutes.`,
                };
            }
            const after = result;
            runWarnings.push(...(after.reviewWarnings ?? []));
            if (after.lastReviewError) runErrors.push(after.lastReviewError);
            if (!collected) {
                return {
                    completed: false,
                    failureReason: 'The review ended without its findings.',
                };
            }
            const timedOut =
                loopStopped ??
                (stop.signal.aborted && !context.parentSignal?.aborted);
            const withoutCheckout = checkoutExpected && !sandbox;
            const completed =
                collected.completion.completed && !timedOut && !withoutCheckout;
            const failureReason = timedOut
                ? `Its review was stopped after ${minutes(window)} minutes.`
                : withoutCheckout && collected.completion.completed
                  ? 'Its sandbox could not be created, so it reviewed the diff without the repository.'
                  : collected.completion.failureReason;
            logger.log({
                message: `[ULTRA] PR#${prNumber}: ${model.modelName} ${completed ? 'completed' : 'failed'} with ${collected.findings.length} findings`,
                context: 'UltraReview',
                metadata: {
                    ...logMeta,
                    model: model.modelName,
                    position: model.position,
                    completed,
                    failureReason,
                    findings: collected.findings.length,
                },
            });
            return {
                completed,
                failureReason,
                output: collected,
                findings: collected.findings.length,
            };
        },
    });

    let main = await auxiliaryRun;

    const nativeFindings = outputs.flatMap((o) => o.output.findings);
    const auxRules = auxiliary.findings.filter((s) => s.label === 'kody_rules');
    const auxOthers = auxiliary.findings.filter(
        (s) => s.label !== 'kody_rules',
    );
    // What each run already listed under "Also found in".
    const handedOver = [...nativeFindings, ...auxiliary.findings];
    const renderedBefore = new Map(
        handedOver.map((f) => [f, otherLocationsToRender(f)]),
    );
    // A merge that rebuilds a comment keeps its id.
    const renderedBeforeById = new Map(
        handedOver
            .filter((f) => f.id)
            .map((f) => [f.id, otherLocationsToRender(f)]),
    );
    const { merged, trace, merge } = await mergeAcrossModels(
        host,
        main,
        [...nativeFindings, ...auxOthers],
        prNumber,
        state,
        outputs.length + (auxOthers.length ? 1 : 0),
        logMeta,
        limits.mergeDeadlineMs,
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
    renderLocationsAddedAfterRuns(
        deduped,
        // A comment the runs did not hand over is left as it is.
        (finding) =>
            renderedBefore.get(finding) ??
            (finding.id ? renderedBeforeById.get(finding.id) : undefined) ??
            otherLocationsToRender(finding),
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
        // The models' error, not a Kody Rules one the auxiliary pass left.
        if (outcome === 'failed' && runErrors[0]) {
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
        dedupTrace: trace ??
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
