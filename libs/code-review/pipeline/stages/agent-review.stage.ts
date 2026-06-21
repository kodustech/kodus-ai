import * as crypto from 'crypto';

import { createLogger } from '@kodus/flow';
import { Output, jsonSchema } from 'ai';
import { Inject, Injectable } from '@nestjs/common';
import { tracedGenerateText } from '@libs/code-review/infrastructure/agents/llm/agent-loop';
import { resolveAdaptiveProfile } from '@libs/code-review/infrastructure/agents/llm/adaptive-fit';
import { resolveContextWindow } from '@libs/code-review/infrastructure/agents/llm/model-context-window';
import {
    dedupReviewWarnings,
    type ReviewWarning,
} from '@libs/code-review/infrastructure/agents/llm/review-warnings';
import {
    withStructuredOutputFallback,
    NoStructuredFallbackModelError,
    getModelName,
} from '@libs/code-review/infrastructure/agents/llm/byok-to-vercel';
import { buildKodyRuleLink } from '@libs/code-review/utils/build-kody-rule-link';
import {
    buildLangfuseTelemetry,
    type LangfuseTelemetryMetadata,
} from '@libs/core/log/langfuse';

import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { ReviewOrchestratorService } from '@libs/code-review/infrastructure/agents/review-orchestrator.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { AgentProgressEvent } from '@libs/code-review/infrastructure/agents/base-code-review-agent.provider';

import { GraphContextService } from '@libs/code-review/infrastructure/adapters/services/graph/graph-context.service';
import {
    IRepositoryService,
    REPOSITORY_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/RepositoryService.contract';
import { AstGraphStatus } from '@libs/code-review/infrastructure/adapters/repositories/schemas/repository.model';
import {
    resolveKodyRuleSeverityLevel,
    SeverityLevel,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    CodeReviewPipelineContext,
    DedupTraceGroupSummary,
    DedupTraceSuggestionSummary,
    DedupTraceSummary,
} from '../context/code-review-pipeline.context';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import {
    ReviewErrorCategory,
    classifyLLMError,
    getClassification,
} from '@libs/code-review/infrastructure/agents/llm/error-classifier';

/**
 * Extract valid line ranges from a unified diff patch.
 * Returns an array of [start, end] tuples representing lines on the RIGHT side
 * that GitHub allows for inline comments.
 *
 * For each hunk, we track which RIGHT-side lines exist (context + added).
 * GitHub only allows comments on lines that appear in the diff.
 */
function extractValidDiffLines(patch?: string): Array<[number, number]> {
    if (!patch) return [];

    const ranges: Array<[number, number]> = [];
    const lines = patch.split('\n');
    let rightLine = 0;
    let hunkStart = 0;

    for (const line of lines) {
        // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (hunkMatch) {
            // Save previous hunk
            if (hunkStart > 0 && rightLine > hunkStart) {
                ranges.push([hunkStart, rightLine - 1]);
            }
            rightLine = parseInt(hunkMatch[1], 10);
            hunkStart = rightLine;
            continue;
        }

        if (hunkStart === 0) continue; // before first hunk

        if (line.startsWith('-')) {
            // Deleted line — only exists on LEFT side, skip
            continue;
        }

        if (line.startsWith('\\')) {
            // "No newline at end of file" — skip
            continue;
        }

        // Context line (space prefix) or added line (+) — exists on RIGHT
        rightLine++;
    }

    // Save last hunk
    if (hunkStart > 0 && rightLine > hunkStart) {
        ranges.push([hunkStart, rightLine - 1]);
    }

    return ranges;
}

/**
 * Snap suggestion line numbers to the closest valid diff range.
 * If the suggestion lines don't overlap any diff range, finds the nearest one.
 */
function snapLinesToDiff(
    suggestion: Partial<CodeSuggestion>,
    validRanges: Array<[number, number]>,
): Partial<CodeSuggestion> {
    if (validRanges.length === 0) return suggestion;

    const start = suggestion.relevantLinesStart;
    const end = suggestion.relevantLinesEnd;

    if (!start || !end) {
        // No lines specified — use the first valid range
        const [rs, re] = validRanges[0];
        return {
            ...suggestion,
            relevantLinesStart: rs,
            relevantLinesEnd: Math.min(re, rs + 5),
        };
    }

    // Find all overlapping ranges and pick the best one (largest overlap)
    let bestOverlap: [number, number] | null = null;
    let bestOverlapSize = 0;

    for (const [rs, re] of validRanges) {
        if (start <= re && end >= rs) {
            const overlapStart = Math.max(start, rs);
            const overlapEnd = Math.min(end, re);
            const overlapSize = overlapEnd - overlapStart;
            if (overlapSize > bestOverlapSize) {
                bestOverlapSize = overlapSize;
                bestOverlap = [overlapStart, overlapEnd];
            }
        }
    }

    if (bestOverlap) {
        return {
            ...suggestion,
            relevantLinesStart: bestOverlap[0],
            relevantLinesEnd: bestOverlap[1],
        };
    }

    // No overlap — find the closest range
    let closestRange = validRanges[0];
    let closestDist = Infinity;

    for (const [rs, re] of validRanges) {
        const dist = Math.min(Math.abs(start - rs), Math.abs(start - re));
        if (dist < closestDist) {
            closestDist = dist;
            closestRange = [rs, re];
        }
    }

    const [rs, re] = closestRange;
    const clampedStart = Math.max(rs, Math.min(start, re));
    const clampedEnd = Math.min(re, Math.max(clampedStart, end));

    return {
        ...suggestion,
        relevantLinesStart: clampedStart,
        relevantLinesEnd: clampedEnd,
    };
}

/**
 * Pipeline stage that runs the agent-based code review.
 *
 * Agent-based code review:
 * - Passes all changed files + sandbox to the ReviewOrchestrator
 * - Orchestrator dispatches specialized agents (bug, security, performance) in parallel
 * - Agents investigate the codebase using sandbox tools before suggesting
 * - Results are stored in context.fileAnalysisResults for downstream stages
 */
@Injectable()
export class AgentReviewStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'AgentReviewStage';
    readonly label = 'Agent-Based Code Review';
    readonly visibility = StageVisibility.PRIMARY;

    private readonly logger = createLogger(AgentReviewStage.name);

    private summarizeDedupSuggestion(
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

    private normalizeSeverity(severity?: string): string {
        switch ((severity || '').toLowerCase()) {
            case 'critical':
            case SeverityLevel.CRITICAL:
                return SeverityLevel.CRITICAL;
            case 'high':
            case SeverityLevel.HIGH:
                return SeverityLevel.HIGH;
            case 'medium':
                return SeverityLevel.MEDIUM;
            case 'low':
            case SeverityLevel.LOW:
                return SeverityLevel.LOW;
            default:
                return SeverityLevel.MEDIUM;
        }
    }

    constructor(
        private readonly reviewOrchestrator: ReviewOrchestratorService,
        private readonly observabilityService: ObservabilityService,
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        private readonly graphContext: GraphContextService,
        @Inject(REPOSITORY_SERVICE_TOKEN)
        private readonly repositoryService: IRepositoryService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const prNumber = context.pullRequest?.number;
        const changedFiles = context.changedFiles;

        if (!changedFiles?.length) {
            this.logger.log({
                message: `[AGENT] Skipping agent review: no changed files for PR#${prNumber}`,
                context: this.stageName,
            });
            return context;
        }

        // When no sandbox is available (e.g. trial mode, or sandbox provider
        // unavailable), run the agent in "self-contained" mode: no tools,
        // single-shot analysis on the diff content inlined in the user
        // prompt. The orchestrator/agent-loop detect the empty tools case
        // and switch to a self-contained system/user prompt variant.
        const hasSandbox = !!context.sandboxHandle?.remoteCommands;
        if (!hasSandbox) {
            this.logger.log({
                message: `[AGENT] Running self-contained agent review for PR#${prNumber} (no sandbox available)`,
                context: this.stageName,
                metadata: {
                    prNumber,
                    organizationAndTeamData: context.organizationAndTeamData,
                    reason: 'no_sandbox',
                },
            });
        }

        const reviewOptions = context.codeReviewConfig?.reviewOptions || {
            bug: true,
            security: true,
            performance: true,
        };

        // Resolve adaptive-fit profile once for this run. The profile drives
        // which fidelity strategies (drop callGraph, compact prompt, etc) fire
        // and is also passed through to BaseCodeReviewAgentProvider via
        // ReviewAgentInput so per-agent code paths gate on the same flags.
        // Per-repo/directory model override (byokModel) takes priority over
        // the org-level main.model when present — same resolution the agent
        // uses internally (`base-code-review-agent.provider.ts:541-551`).
        const mainByok = context.codeReviewConfig?.byokConfig?.main;
        const overrideModel =
            context.codeReviewConfig?.byokModel?.trim();
        const byokWithOverride =
            overrideModel && mainByok
                ? {
                      ...context.codeReviewConfig?.byokConfig,
                      main: { ...mainByok, model: overrideModel },
                  }
                : context.codeReviewConfig?.byokConfig;
        // Use the same model-name formatter the agent uses (provider:model)
        // so stage-emitted warnings and agent-emitted warnings share a
        // dedup key. Otherwise dedupReviewWarnings sees them as distinct
        // and the user sees duplicate bullets (PROMPT_COMPACTED listed
        // twice — once with "gemini-2.5-flash" and once with
        // "google_gemini:gemini-2.5-flash").
        const effectiveModelName = getModelName(byokWithOverride);
        const effectiveContextWindow = resolveContextWindow({
            byokMaxInputTokens: mainByok?.maxInputTokens,
            modelName: overrideModel || mainByok?.model || '',
        });
        const adaptiveProfile = resolveAdaptiveProfile(effectiveContextWindow);
        const stageWarnings: ReviewWarning[] = [];
        const emitStageWarning = (
            kind: ReviewWarning['kind'],
            detail?: string,
        ) => {
            stageWarnings.push({
                kind,
                reason: 'small_context_window',
                contextWindowTokens: effectiveContextWindow,
                modelName: effectiveModelName || 'unknown',
                detail,
            });
        };

        if (adaptiveProfile.kind !== 'full') {
            this.logger.log({
                message: `[AGENT] adaptive-fit profile=${adaptiveProfile.kind} window=${effectiveContextWindow} model=${effectiveModelName}`,
                context: this.stageName,
                metadata: {
                    prNumber,
                    profile: adaptiveProfile.kind,
                    contextWindow: effectiveContextWindow,
                    modelName: effectiveModelName,
                    flags: {
                        dropCallGraph: adaptiveProfile.dropCallGraph,
                        skipHeavyPasses: adaptiveProfile.skipHeavyPasses,
                        compactPrompt: adaptiveProfile.compactPrompt,
                        allOptional: adaptiveProfile.allOptional,
                        maxDiffChars: adaptiveProfile.maxDiffChars,
                        lowSignalFilterUnconditional:
                            adaptiveProfile.lowSignalFilterUnconditional,
                    },
                },
            });
        }

        const startTime = Date.now();

        this.logger.log({
            message: `[AGENT] Starting agent review for PR#${prNumber} with ${changedFiles.length} files`,
            context: this.stageName,
            metadata: {
                prNumber,
                filesCount: changedFiles.length,
                reviewOptions,
                organizationId: context.organizationAndTeamData?.organizationId,
                teamId: context.organizationAndTeamData?.teamId,
            },
        });

        try {
            // Build progress callback for real-time agent traces in PR timeline
            const executionUuid =
                context.pipelineMetadata?.lastExecution?.uuid ||
                context.correlationId;
            const repositoryId = context.repository?.id;

            // Shared telemetry metadata for all Langfuse-traced calls in this pipeline run
            const telemetryMeta: LangfuseTelemetryMetadata = {
                organizationId: context.organizationAndTeamData?.organizationId,
                teamId: context.organizationAndTeamData?.teamId,
                pullRequestId: prNumber,
                repositoryId,
            };

            const onAgentProgress = this.createAgentProgressCallback(
                executionUuid,
                prNumber,
                repositoryId,
            );

            // Generate call graph context from AST graph in DB (via kodus-graph in E2B sandbox)
            let callGraph = '';
            // Adaptive fit: a 1–3K-token callGraph fragment is the cheapest
            // thing to drop when the model's window can't hold the full
            // prompt. `light+` profiles always skip it. The agent still has
            // grep/readFile to investigate cross-file relationships on demand.
            const shouldBuildCallGraph = !adaptiveProfile.dropCallGraph;
            if (!shouldBuildCallGraph) {
                this.logger.log({
                    message: `[AGENT] adaptive-fit (${adaptiveProfile.kind}): skipping callGraph build to fit context window`,
                    context: this.stageName,
                });
                emitStageWarning('CALLGRAPH_DROPPED');
            }
            if (shouldBuildCallGraph) {
              try {
                const sandboxType = context.sandboxHandle?.type ?? 'unknown';
                const hasSandbox = !!context.sandboxHandle?.run;
                this.logger.log({
                    message: `[AGENT] sandboxHandle check: type=${sandboxType}, hasSandbox=${hasSandbox}, platform=${context.platformType}, repoId=${context.repository?.id}`,
                    context: this.stageName,
                    metadata: {
                        sandboxType,
                        hasSandbox,
                        platform: context.platformType,
                        repoExternalId: context.repository?.id,
                    },
                });

                if (context.sandboxHandle?.run) {
                    const repo = await this.repositoryService.findByExternalId(
                        context.platformType,
                        String(context.repository?.id || ''),
                    );

                    this.logger.log({
                        message: `[AGENT] repo lookup: found=${!!repo}, astGraphStatus=${repo?.astGraphStatus ?? 'N/A'}, uuid=${repo?.uuid ?? 'N/A'}`,
                        context: this.stageName,
                        metadata: {
                            repoExternalId: context.repository?.id,
                            repoUuid: repo?.uuid,
                            astGraphStatus: repo?.astGraphStatus,
                        },
                    });

                    if (repo?.astGraphStatus === AstGraphStatus.READY) {
                        callGraph = await this.graphContext.generateContext(
                            context.sandboxHandle,
                            changedFiles,
                            repo.uuid,
                        );
                    } else {
                        this.logger.log({
                            message: `[AGENT] No AST graph in DB for PR#${prNumber} (status=${repo?.astGraphStatus || 'not found'}), falling back to legacy (changed-files only)`,
                            context: this.stageName,
                        });
                        callGraph =
                            await this.graphContext.generateContextLegacy(
                                context.sandboxHandle,
                                changedFiles,
                                context.sandboxHandle?.baseBranch ||
                                    context.pullRequest?.base?.ref ||
                                    context.repository?.defaultBranch,
                            );
                    }
                } else {
                    this.logger.warn({
                        message: `[AGENT] No sandboxHandle object (type=${sandboxType}), skipping kodus-graph for PR#${prNumber}`,
                        context: this.stageName,
                    });
                }

                if (callGraph) {
                    this.logger.log({
                        message: `[AGENT] kodus-graph context: ${callGraph.length} chars for PR#${prNumber}`,
                        context: this.stageName,
                        metadata: {
                            prNumber,
                            callGraphChars: callGraph.length,
                            callGraphPreview: callGraph.substring(0, 320),
                        },
                    });
                }
            } catch (err) {
                this.logger.warn({
                    message: `[AGENT] Call graph failed for PR#${prNumber}, proceeding without it`,
                    context: this.stageName,
                    error: err,
                    metadata: {
                        sandboxType: context.sandboxHandle?.type,
                        hasSandbox: !!context.sandboxHandle?.run,
                    },
                });
            }
            } // end if (shouldBuildCallGraph)

            const result = await this.reviewOrchestrator.execute({
                organizationAndTeamData: context.organizationAndTeamData,
                changedFiles,
                // remoteCommands is undefined when no sandbox is available
                // (e.g. trial mode). The agent loop detects the empty tools
                // case and switches to a self-contained analysis variant.
                remoteCommands: context.sandboxHandle?.remoteCommands as any,
                prNumber,
                repositoryId,
                repositoryFullName:
                    context.repository?.fullName ||
                    context.pullRequest?.base?.repo?.fullName ||
                    '',
                languageResultPrompt:
                    context.codeReviewConfig?.languageResultPrompt || 'en-US',
                memoryRules: context.codeReviewConfig?.kodyMemoryRules,
                v2PromptOverrides: context.codeReviewConfig?.v2PromptOverrides,
                generationMain:
                    context.codeReviewConfig?.v2PromptOverrides?.generation
                        ?.main,
                prTitle: context.pullRequest?.title,
                prBody: context.pullRequest?.body,
                kodyRules: context.codeReviewConfig?.kodyRules,
                reviewOptions,
                onAgentProgress,
                gitHubToken: await this.resolveGitHubToken(context),
                baseBranch:
                    context.sandboxHandle?.baseBranch ||
                    context.pullRequest?.base?.ref ||
                    context.repository?.defaultBranch,
                callGraph,
                callGraphJson: context.callGraphJson,
                reviewMode: context.codeReviewConfig?.reviewMode || 'normal',
                // Trial reviews get a forced default model (only consulted
                // when there's no BYOK config). Two distinct "trial" surfaces,
                // each with its OWN model:
                //   1. Subscription trial — signed-up orgs in their 14-day
                //      trial (`subscriptionStatus === 'trial'`, captured by
                //      ValidatePrerequisitesStage). Routed to Kimi K2.6: they
                //      run the managed pipeline with no BYOK, so without this
                //      they'd burn the expensive 3.1-pro default on Kodus's
                //      dime for the whole trial window. The `kimi-` prefix
                //      routes through Moonshot's OpenAI-compatible endpoint in
                //      byokToVercelModel (reads API_MOONSHOT_API_KEY — that env
                //      MUST be set in the cloud deployment).
                //   2. Anonymous public demo (`isTrialMode`, try.kodus.io) —
                //      kept on Gemini 3 Flash: it's a latency-sensitive public
                //      demo and the try UI advertises "Gemini 3 Flash". Without
                //      this it would fall back to the slow 3.1-pro default
                //      (~4-5 min).
                // Either override is ignored when a BYOK config is present
                // (byokToVercelModel prefers BYOK), so a trial org that
                // configured its own key keeps using it.
                // `isTrialMode` lives on the CLI pipeline context — we can't
                // import that type here without inverting the dep graph
                // (cli-review depends on code-review), so the cast is
                // intentional.
                defaultModelOverride:
                    context.pipelineMetadata?.subscriptionStatus === 'trial'
                        ? 'kimi-k2.6'
                        : (context as { isTrialMode?: boolean }).isTrialMode
                          ? 'gemini-3-flash-preview'
                          : undefined,
                // Per-repo/directory model override resolved by ValidateConfigStage.
                byokModel: context.codeReviewConfig?.byokModel,
                // Adaptive-fit profile: agents read this to decide whether
                // to compact the prompt, force all-optional tiering, drop
                // low-signal files unconditionally, truncate per-file diffs,
                // and skip heavy passes. Resolved once at the stage so the
                // stage-level decisions (callGraph, heavy passes) and
                // per-agent decisions agree.
                adaptiveProfile,
                // Auto-skip heavy passes (verifier, second-chance, rescue)
                // when the profile says so. These are independent
                // generateText calls that re-incur the full prompt overhead;
                // on small windows they're guaranteed to refire the same
                // preflight error. Don't override an explicit caller value.
                skipHeavyPasses:
                    adaptiveProfile.skipHeavyPasses || undefined,
                // Forwarded from the workflow job timeout. The router builds
                // an AbortController; here we pass it through so when the
                // 1h45min budget fires, the agent-loop's local controller is
                // aborted via parentSignal composition.
                parentSignal: context.parentSignal,
            });

            // Emit profile-driven warnings up here at the stage so they
            // surface even when the agent's overhead preflight throws
            // before its own emission points. These four are decided
            // purely by the resolved profile — no PR-specific condition
            // needed. The agent will re-emit some of them when it runs;
            // dedupReviewWarnings folds the duplicates so the user sees
            // each kind once. Without this, a preflight-failed run only
            // shows 2 warnings (CALLGRAPH_DROPPED + HEAVY_PASSES_SKIPPED)
            // while a successful run on the same profile shows 4–5 —
            // confusing UX where the failure looks "less degraded" than
            // the success.
            //
            // The agent-only warnings (LOW_SIGNAL_FILES_DROPPED with
            // file count, DIFF_TRUNCATED with file names) are conditional
            // on real PR state and intentionally NOT emitted here — we
            // don't know yet whether the conditions apply.
            if (adaptiveProfile.skipHeavyPasses) {
                emitStageWarning('HEAVY_PASSES_SKIPPED');
            }
            if (adaptiveProfile.compactPrompt) {
                emitStageWarning('PROMPT_COMPACTED');
            }
            if (adaptiveProfile.allOptional) {
                emitStageWarning('HUNK_HEADERS_ONLY');
            }

            const durationMs = Date.now() - startTime;

            this.logger.log({
                message: `[TIMING] AgentReviewStage completed for PR#${prNumber}: ${result.suggestions.length} suggestions in ${durationMs}ms`,
                context: this.stageName,
                metadata: {
                    prNumber,
                    suggestionsCount: result.suggestions.length,
                    agentResults: (result.agentResults ?? []).map((r) => ({
                        agent: r.agentName,
                        category: r.agentCategory,
                        replicaIndex: r.agentReplicaIndex,
                        replicaTotal: r.agentReplicaTotal,
                        suggestions: r.suggestions.length,
                        turns: r.turnsUsed,
                        durationMs: r.durationMs,
                    })),
                    durationMs,
                },
            });

            // Classify agent failures so the pipeline's final conclusion
            // reflects them. Core agents (bug / security / performance /
            // generalist) are the primary output — losing one of them is a
            // critical error and should red-flag the check. Kody-rules is
            // auxiliary: the review still has value from the core agents,
            // so its failure is partial (maps to NEUTRAL on GitHub).
            const CRITICAL_AGENTS = new Set([
                'generalist',
                'bug',
                'security',
                'performance',
            ]);
            for (const failure of result.failures || []) {
                const severity = CRITICAL_AGENTS.has(failure.agentName)
                    ? 'critical'
                    : 'partial';
                context = this.updateContext(context, (draft) => {
                    draft.errors.push({
                        pipelineId: context.pipelineMetadata?.pipelineId,
                        stage: this.stageName,
                        substage: `agent:${failure.agentName}`,
                        error: failure.error,
                        severity,
                        metadata: {
                            agentName: failure.agentName,
                            category: failure.category,
                            prNumber,
                        },
                    });
                });
            }

            // Pick the best failure to surface to the user (used by the
            // end-review comment to interpolate the reason). Severity-based
            // bookkeeping already happened in the loop above — this only
            // chooses *which* failure's classification gets attached to the
            // context for the message. A critical agent with a mapped (non-
            // UNKNOWN) classification wins; fall back to any critical, then
            // any failure.
            const failures = result.failures ?? [];
            if (failures.length > 0) {
                const reviewProvider =
                    typeof context.codeReviewConfig?.byokConfig?.main
                        ?.provider === 'string'
                        ? (context.codeReviewConfig.byokConfig.main
                              .provider as string)
                        : undefined;
                const classifyFailure = (f: (typeof failures)[number]) =>
                    getClassification(f.error) ??
                    classifyLLMError(f.error, reviewProvider);
                const criticalFailures = failures.filter((f) =>
                    CRITICAL_AGENTS.has(f.agentName),
                );
                const ranked = (
                    criticalFailures.length > 0 ? criticalFailures : failures
                ).slice();
                ranked.sort((a, b) => {
                    const aMapped =
                        classifyFailure(a).category !==
                        ReviewErrorCategory.UNKNOWN;
                    const bMapped =
                        classifyFailure(b).category !==
                        ReviewErrorCategory.UNKNOWN;
                    if (aMapped === bMapped) return 0;
                    return aMapped ? -1 : 1;
                });
                const chosen = ranked[0];
                const classification = classifyFailure(chosen);

                context = this.updateContext(context, (draft) => {
                    draft.lastReviewError = {
                        category: classification.category,
                        provider: classification.provider,
                        friendlyMessage: classification.friendlyMessage,
                        agentName: chosen.agentName,
                        occurredAt: new Date(),
                    };
                });

                this.logger.log({
                    message: `[AGENT] Review failures: ${failures.length} (critical=${criticalFailures.length}, category=${classification.category})`,
                    context: this.stageName,
                    metadata: {
                        prNumber,
                        errorCategory: classification.category,
                        provider: classification.provider,
                        agentName: chosen.agentName,
                        failureCount: failures.length,
                        criticalCount: criticalFailures.length,
                    },
                });
            }

            // Surface adaptive-fit fidelity warnings (stage-level +
            // orchestrator-deduped per-agent) so the end-review PR comment
            // can render a collapsible "review fidelity reduced" section,
            // and so telemetry can roll up "how often does each kind fire".
            // Stage-level warnings (CALLGRAPH_DROPPED, HEAVY_PASSES_SKIPPED)
            // come from this stage's own decisions; orchestrator's
            // result.warnings come from the per-agent loops.
            // Dedup at the merge point — a stage-level CALLGRAPH_DROPPED
            // and an agent-level one for the same (model, window) fold
            // into a single bullet in the user-facing notice.
            const allWarnings = dedupReviewWarnings([
                ...stageWarnings,
                ...(result.warnings ?? []),
            ]);
            if (allWarnings.length > 0) {
                context = this.updateContext(context, (draft) => {
                    draft.reviewWarnings = allWarnings;
                });
                this.logger.log({
                    message: `[AGENT] Review fidelity warnings: ${allWarnings
                        .map((w) => w.kind)
                        .join(', ')}`,
                    context: this.stageName,
                    metadata: {
                        prNumber,
                        warningKinds: allWarnings.map((w) => w.kind),
                        warningCount: allWarnings.length,
                    },
                });
            }

            // Collect suggestions discarded by severity filter and verify
            const allDiscarded: Partial<CodeSuggestion>[] = [];
            for (const agentResult of result.agentResults ?? []) {
                if (agentResult.discardedBySeverity?.length) {
                    for (const s of agentResult.discardedBySeverity) {
                        allDiscarded.push({
                            ...s,
                            priorityStatus:
                                PriorityStatus.DISCARDED_BY_SEVERITY,
                        });
                    }
                }
                if (agentResult.discardedByVerify?.length) {
                    for (const s of agentResult.discardedByVerify) {
                        allDiscarded.push({
                            ...s,
                            priorityStatus:
                                PriorityStatus.DISCARDED_BY_SAFEGUARD,
                        });
                    }
                }
            }

            // Snap suggestion line numbers to valid diff ranges before passing downstream.
            // GitHub rejects inline comments on lines that aren't part of the diff.
            const validatedSuggestions = result.suggestions.map((s) => {
                const file = changedFiles.find(
                    (f) => f.filename === s.relevantFile,
                );
                if (!file) return s;
                const validRanges = extractValidDiffLines(file.patch);
                const snapped = snapLinesToDiff(s, validRanges);
                if (
                    snapped.relevantLinesStart !== s.relevantLinesStart ||
                    snapped.relevantLinesEnd !== s.relevantLinesEnd
                ) {
                    this.logger.log({
                        message: `[AGENT] Snapped lines for ${s.relevantFile}: ${s.relevantLinesStart}-${s.relevantLinesEnd} → ${snapped.relevantLinesStart}-${snapped.relevantLinesEnd}`,
                        context: this.stageName,
                    });
                }
                return snapped;
            });

            // Verify/Discover removed — was hurting recall across all models.
            // Benchmark showed F1 drops of -5.7pp to -18.3pp with verify enabled.
            const reflectedSuggestions = validatedSuggestions;

            const kodyRulesSuggestions = reflectedSuggestions.filter(
                (s) => s.label === 'kody_rules',
            );
            const nonKodyRulesSuggestions = reflectedSuggestions.filter(
                (s) => s.label !== 'kody_rules',
            );

            // Normalize Kody Rules legacy severity (critical/issue/warning) into the
            // v2 severity scale (critical/high/medium/low). The agent returns the rule
            // UUID in brokenKodyRulesIds — use it for exact matching.
            const kodyRulesById = new Map(
                (context.codeReviewConfig?.kodyRules ?? [])
                    .filter((r) => r.uuid)
                    .map((r) => [r.uuid!, r]),
            );
            const kodyRulesWithSeverity: Partial<CodeSuggestion>[] =
                kodyRulesSuggestions.map((s) => {
                    const ruleUuid = s.brokenKodyRulesIds?.[0];
                    const matchedRule = ruleUuid
                        ? kodyRulesById.get(ruleUuid)
                        : undefined;
                    const legacySeverity = matchedRule
                        ? resolveKodyRuleSeverityLevel(matchedRule)
                        : SeverityLevel.HIGH;

                    return {
                        ...s,
                        severity: this.normalizeSeverity(legacySeverity),
                    };
                });

            const severityNormalizedNonRules: Partial<CodeSuggestion>[] =
                nonKodyRulesSuggestions.map((suggestion) => ({
                    ...suggestion,
                    severity: this.normalizeSeverity(suggestion.severity),
                }));

            const severityNormalized: Partial<CodeSuggestion>[] = [
                ...severityNormalizedNonRules,
                ...kodyRulesWithSeverity,
            ];

            // Deduplicate Kody Rules deterministically by ruleUuid.
            // No LLM call needed — the ruleUuid unambiguously identifies
            // which rule each finding belongs to, so same-rule findings
            // can be merged without asking a model to decide.
            //
            // Merge strategy per rule group:
            //   - PR-level (no relevantFile): keep 1 finding only. A PR-
            //     level rule can only be violated once per PR (e.g. "PR
            //     description required" — either the body is weak or it
            //     isn't). Drop the rest.
            //   - File-level: keep the most detailed finding as the
            //     representative and append "Also found in: <file>:<line>"
            //     for the other occurrences, same pattern used by the
            //     LLM-based dedup on non-kody suggestions. One comment
            //     covers every occurrence of the same rule.
            const allKodyRules = severityNormalized.filter(
                (s) => s.label === 'kody_rules',
            );
            const kodyRulesForDedup = this.dedupKodyRulesByRuleUuid(
                allKodyRules,
                prNumber,
            );
            const nonKodyRulesForDedup = severityNormalized.filter(
                (s) => s.label !== 'kody_rules',
            );

            let dedupedNonRules = nonKodyRulesForDedup;
            let dedupTrace: DedupTraceSummary = {
                status:
                    nonKodyRulesForDedup.length <= 1 ? 'skipped' : 'success',
                totalClassifiedCount: severityNormalized.length,
                kodyRulesSkippedCount: kodyRulesForDedup.length,
                nonKodyInputCount: nonKodyRulesForDedup.length,
                nonKodyOutputCount: nonKodyRulesForDedup.length,
                finalOutputCount: severityNormalized.length,
                uniqueCount: nonKodyRulesForDedup.length,
                groupsCount: 0,
                removedCount: 0,
                unique: nonKodyRulesForDedup.map((suggestion) =>
                    this.summarizeDedupSuggestion(suggestion),
                ),
            };
            try {
                const dedupResult = await this.deduplicateSuggestions(
                    nonKodyRulesForDedup,
                    prNumber,
                    context.codeReviewConfig?.byokConfig,
                    telemetryMeta,
                );
                dedupedNonRules = dedupResult.suggestions;
                dedupTrace = {
                    ...dedupResult.trace,
                    totalClassifiedCount: severityNormalized.length,
                    kodyRulesSkippedCount: kodyRulesForDedup.length,
                    nonKodyInputCount: nonKodyRulesForDedup.length,
                    nonKodyOutputCount: dedupResult.suggestions.length,
                    finalOutputCount:
                        dedupResult.suggestions.length +
                        kodyRulesForDedup.length,
                };
            } catch (dedupError) {
                this.logger.warn({
                    message: `[DEDUP] Failed for PR#${prNumber}, keeping all suggestions`,
                    context: this.stageName,
                    error: dedupError,
                });
                dedupTrace = {
                    ...dedupTrace,
                    status: 'failed-keep-all',
                    errorMessage:
                        dedupError instanceof Error
                            ? dedupError.message
                            : String(dedupError),
                };
            }

            let deduped = [...dedupedNonRules, ...kodyRulesForDedup];

            // NOTE: Kody Rule link enrichment happens AFTER the content
            // formatter (see block further below). Doing it before would
            // let the formatter LLM strip or reword the link when it
            // collapses WHAT/WHY/HOW into natural prose.

            // Reclassify severity using dedicated criteria (Gemini Flash)
            // The agent assigns rough severity during investigation; this step
            // applies the definitive criteria (default or client-custom) without
            // biasing the agent's bug-finding behavior.
            try {
                const {
                    classifySeverity,
                } = require('@libs/code-review/infrastructure/agents/llm/classify-severity');
                const severityMap = await classifySeverity(
                    deduped.map((s) => ({
                        relevantFile: s.relevantFile || '',
                        suggestionContent: s.suggestionContent || '',
                        oneSentenceSummary: s.oneSentenceSummary || '',
                        existingCode: s.existingCode || '',
                        improvedCode: s.improvedCode || '',
                    })),
                    context.codeReviewConfig?.v2PromptOverrides,
                    context.codeReviewConfig?.byokConfig,
                );
                for (let i = 0; i < deduped.length; i++) {
                    const classified = severityMap.get(i);
                    if (!classified) {
                        continue;
                    }
                    const hasKodyRuleSeverity =
                        deduped[i].brokenKodyRulesIds?.length > 0;
                    if (hasKodyRuleSeverity) {
                        continue;
                    }
                    deduped[i].severity = classified;
                }
                this.logger.log({
                    message: `[AGENT] Reclassified severity for ${deduped.length} suggestions`,
                    context: this.stageName,
                });
            } catch (err) {
                this.logger.warn({
                    message: `[AGENT] Severity classification failed, keeping agent-assigned severity: ${err instanceof Error ? err.message : String(err)}`,
                    context: this.stageName,
                });
            }

            // Re-apply severity filter AFTER reclassification.
            // The agent loop already filters once (to save verify tokens),
            // but the SeverityClassifier can change the final severity.
            // Without this second pass, a finding the LLM initially tagged
            // as HIGH would pass the early filter, get reclassified to LOW,
            // and appear on the PR below the user's configured threshold.
            //
            // Kody Rules are exempt by default (team-defined rules always
            // surface regardless of severity). Teams can opt in to filter
            // them too via suggestionControl.applyFiltersToKodyRules=true.
            const severityFilter =
                context.codeReviewConfig?.suggestionControl
                    ?.severityLevelFilter;
            const applyFiltersToKodyRules =
                context.codeReviewConfig?.suggestionControl
                    ?.applyFiltersToKodyRules === true;
            if (
                severityFilter &&
                severityFilter !== 'low' &&
                deduped.length > 0
            ) {
                const acceptedLevels: Record<string, string[]> = {
                    critical: ['critical'],
                    high: ['critical', 'high'],
                    medium: ['critical', 'high', 'medium'],
                    low: ['critical', 'high', 'medium', 'low'],
                };
                const accepted =
                    acceptedLevels[severityFilter] || acceptedLevels.low;
                const before = deduped.length;
                const keeps = (s: Partial<CodeSuggestion>) => {
                    if (s.label === 'kody_rules' && !applyFiltersToKodyRules) {
                        return true; // kody rules bypass by default
                    }
                    return accepted.includes(
                        (s.severity || 'medium').toLowerCase(),
                    );
                };
                const droppedBySeverity = deduped.filter((s) => !keeps(s));
                deduped = deduped.filter(keeps);
                for (const s of droppedBySeverity) {
                    allDiscarded.push({
                        ...s,
                        priorityStatus: PriorityStatus.DISCARDED_BY_SEVERITY,
                    });
                }
                if (deduped.length < before) {
                    this.logger.log({
                        message: `[AGENT] Post-classification severity filter: ${before - deduped.length} suggestions below ${severityFilter} threshold removed (applyFiltersToKodyRules=${applyFiltersToKodyRules})`,
                        context: this.stageName,
                    });
                }
            }

            // Clean up suggestion text: remove WHAT/WHY/HOW labels, merge into natural prose
            try {
                const {
                    formatSuggestionContent,
                } = require('@libs/code-review/infrastructure/agents/llm/format-suggestion-content');
                const formatted = await formatSuggestionContent(
                    deduped.map((s) => ({
                        suggestionContent: s.suggestionContent || '',
                        existingCode: s.existingCode || '',
                        improvedCode: s.improvedCode || '',
                        relevantFile: s.relevantFile || '',
                        language: s.language || '',
                    })),
                    {
                        customWritingGuidelines:
                            context.codeReviewConfig?.v2PromptOverrides
                                ?.generation?.main,
                        byokConfig: context.codeReviewConfig?.byokConfig,
                        languageResultPrompt:
                            context.codeReviewConfig?.languageResultPrompt,
                    },
                );
                for (const [i, fmt] of formatted) {
                    if (deduped[i]) {
                        deduped[i].suggestionContent = fmt.suggestionContent;
                    }
                }
                this.logger.log({
                    message: `[AGENT] Formatted ${formatted.size}/${deduped.length} suggestion contents`,
                    context: this.stageName,
                });
            } catch (err) {
                this.logger.warn({
                    message: `[AGENT] Content formatting failed, keeping original text: ${err instanceof Error ? err.message : String(err)}`,
                    context: this.stageName,
                });
            }

            // Enrich kody_rules suggestions with markdown links to the rule
            // page. Runs AFTER the content formatter so the formatter LLM
            // cannot drop the "Kody rule violation: ..." appendix while
            // rewriting prose (observed with gemini-3-flash-preview on
            // short PR-level findings).
            const baseUrl = process.env.API_USER_INVITE_BASE_URL || '';
            for (const s of deduped) {
                if (s.label !== 'kody_rules' || !s.brokenKodyRulesIds?.[0]) {
                    continue;
                }
                const ruleId = s.brokenKodyRulesIds[0];
                const rule = kodyRulesById.get(ruleId);
                if (!rule?.title) {
                    continue;
                }

                const ruleLink = buildKodyRuleLink(
                    baseUrl,
                    ruleId,
                    rule,
                    context.organizationAndTeamData,
                );
                const escapedTitle = rule.title.replace(
                    /([[\]\\`*_{}()#+\-.!])/g,
                    '\\$1',
                );
                const markdownLink = `[${escapedTitle}](${ruleLink})`;

                let content = s.suggestionContent || '';
                // Skip if the link is already embedded (shouldn't happen
                // now that enrichment runs once post-formatter, but stay
                // idempotent in case this block runs twice).
                if (content.includes(ruleLink)) {
                    continue;
                }

                if (content.includes(rule.title)) {
                    // Replace the first occurrence of the title with the link
                    content = content.replace(rule.title, markdownLink);
                } else {
                    // Append a link line at the end
                    content += `\n\nKody rule violation: ${markdownLink}`;
                }
                s.suggestionContent = content;
            }

            // Separate PR-level kody rules (no file/lines) from file-level suggestions.
            // PR-level suggestions go to validSuggestionsByPR → CreatePrLevelCommentsStage.
            const prLevelSuggestions = deduped.filter(
                (s) =>
                    s.label === 'kody_rules' &&
                    !s.relevantFile &&
                    !s.relevantLinesStart,
            );
            const fileLevelSuggestions = deduped.filter(
                (s) =>
                    !(
                        s.label === 'kody_rules' &&
                        !s.relevantFile &&
                        !s.relevantLinesStart
                    ),
            );

            // Sort file-level suggestions: kody_rules first, then by severity
            // (critical > high > medium > low).
            const severityOrder: Record<string, number> = {
                critical: 0,
                high: 1,
                medium: 2,
                low: 3,
            };
            fileLevelSuggestions.sort((a, b) => {
                // kody_rules always first within the same file
                const aIsRule = a.label === 'kody_rules' ? 0 : 1;
                const bIsRule = b.label === 'kody_rules' ? 0 : 1;
                if (aIsRule !== bIsRule) {
                    return aIsRule - bIsRule;
                }
                // Then by severity
                const aSeverity =
                    severityOrder[this.normalizeSeverity(a.severity)];
                const bSeverity =
                    severityOrder[this.normalizeSeverity(b.severity)];
                return aSeverity - bSeverity;
            });

            return this.updateContext(context, (draft) => {
                const byFile = new Map<string, Partial<CodeSuggestion>[]>();
                for (const s of fileLevelSuggestions) {
                    const file = s.relevantFile || '';
                    if (!byFile.has(file)) {
                        byFile.set(file, []);
                    }
                    byFile.get(file)!.push(s);
                }

                // Build the full set of files we need to emit into
                // `fileAnalysisResults` — one entry per file that has
                // EITHER a valid suggestion OR a discarded-by-safeguard
                // suggestion. Previously we only iterated `byFile`, which
                // meant files where every suggestion was discarded never
                // reached `CreateFileCommentsStage` and the fallback
                // comments for those files silently disappeared from the
                // review.
                const discardedByFile = new Map<
                    string,
                    Partial<CodeSuggestion>[]
                >();
                for (const s of allDiscarded) {
                    const file = s.relevantFile || '';
                    if (!file) continue;
                    if (!discardedByFile.has(file)) {
                        discardedByFile.set(file, []);
                    }
                    discardedByFile.get(file)!.push(s);
                }

                const allAffectedFiles = new Set<string>([
                    ...byFile.keys(),
                    ...discardedByFile.keys(),
                ]);

                draft.fileAnalysisResults = [];
                for (const filename of allAffectedFiles) {
                    const suggestions = byFile.get(filename) ?? [];
                    const file = changedFiles.find(
                        (f) => f.filename === filename,
                    );
                    if (file) {
                        draft.fileAnalysisResults.push({
                            validSuggestionsToAnalyze: suggestions,
                            discardedSuggestionsBySafeGuard:
                                discardedByFile.get(filename) ?? [],
                            file,
                        });
                    } else if (suggestions.length > 0) {
                        // Silent drop guard: the agent produced a finding
                        // for a file that isn't in changedFiles (path
                        // mismatch, filtered-out test/doc, rename, etc.).
                        // Previously these disappeared with no trace —
                        // now we track them as DISCARDED_BY_CODE_DIFF so
                        // the suggestion still reaches Mongo and can be
                        // reconciled later.
                        this.logger.warn({
                            message: `[AGENT] ${suggestions.length} suggestion(s) dropped — relevantFile "${filename}" not found in changedFiles`,
                            context: this.stageName,
                            metadata: {
                                prNumber,
                                filename,
                                suggestionsCount: suggestions.length,
                                availableFilesSample: changedFiles
                                    .slice(0, 10)
                                    .map((f) => f.filename),
                            },
                        });
                        for (const s of suggestions) {
                            allDiscarded.push({
                                ...s,
                                priorityStatus:
                                    PriorityStatus.DISCARDED_BY_CODE_DIFF,
                            });
                        }
                    }
                    // Files with only discarded suggestions AND no match in
                    // changedFiles are silently ignored — they can't
                    // produce a valid comment anchor either way.
                }

                // PR-level kody rules go to validSuggestionsByPR for CreatePrLevelCommentsStage
                if (prLevelSuggestions.length > 0) {
                    if (!draft.validSuggestionsByPR) {
                        draft.validSuggestionsByPR = [];
                    }
                    draft.validSuggestionsByPR.push(
                        ...prLevelSuggestions.map((s) => ({
                            id:
                                s.brokenKodyRulesIds?.[0] ||
                                crypto.randomUUID(),
                            suggestionContent: s.suggestionContent || '',
                            oneSentenceSummary: s.oneSentenceSummary || '',
                            label: (s.label as any) || 'kody_rules',
                            severity: this.normalizeSeverity(
                                s.severity,
                            ) as SeverityLevel,
                            brokenKodyRulesIds: s.brokenKodyRulesIds,
                            deliveryStatus: DeliveryStatus.NOT_SENT,
                        })),
                    );
                }

                draft.dedupTrace = dedupTrace;
                draft.validSuggestions = deduped;
                draft.discardedSuggestions = allDiscarded;
            });
        } catch (error) {
            const durationMs = Date.now() - startTime;
            this.logger.error({
                message: `[AGENT] Agent review failed for PR#${prNumber} after ${durationMs}ms, continuing with empty results`,
                context: this.stageName,
                error,
                metadata: {
                    prNumber,
                    durationMs,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });

            // Non-fatal: return context with empty results
            return this.updateContext(context, (draft) => {
                draft.fileAnalysisResults = [];
            });
        }
    }

    /**
     * Deduplicate Kody Rules findings by ruleUuid.
     *
     * For each rule:
     *   - If it's PR-level (no relevantFile): keep a single finding — a
     *     PR-level rule is either violated or not, multiple comments on
     *     the same PR-level rule are always duplicates.
     *   - If it's file-level: keep the most detailed finding (longest
     *     suggestionContent) and append an "Also found in:" list with
     *     the other `file:lineStart-lineEnd` locations, mirroring the
     *     merge style used by deduplicateSuggestions for non-kody
     *     findings. The team sees one comment per rule, but still knows
     *     every place the rule was violated.
     *
     * Findings without a ruleUuid are passed through unchanged (they
     * should have been filtered earlier by the base agent guard, but we
     * stay defensive).
     */
    private dedupKodyRulesByRuleUuid(
        suggestions: Partial<CodeSuggestion>[],
        prNumber: number,
    ): Partial<CodeSuggestion>[] {
        if (suggestions.length <= 1) {
            return suggestions;
        }

        const groupsByRuleUuid = new Map<string, Partial<CodeSuggestion>[]>();
        const passthrough: Partial<CodeSuggestion>[] = [];

        for (const s of suggestions) {
            const ruleUuid = s.brokenKodyRulesIds?.[0];
            if (!ruleUuid) {
                passthrough.push(s);
                continue;
            }
            const group = groupsByRuleUuid.get(ruleUuid) || [];
            group.push(s);
            groupsByRuleUuid.set(ruleUuid, group);
        }

        const result: Partial<CodeSuggestion>[] = [...passthrough];

        for (const [ruleUuid, group] of groupsByRuleUuid) {
            if (group.length === 1) {
                result.push(group[0]);
                continue;
            }

            const isPrLevel = group.every((s) => !s.relevantFile);
            if (isPrLevel) {
                // Keep the most detailed one, drop the rest.
                const best = [...group].sort(
                    (a, b) =>
                        (b.suggestionContent?.length || 0) -
                        (a.suggestionContent?.length || 0),
                )[0];
                result.push(best);
                this.logger.log({
                    message: `[KODY-DEDUP] PR#${prNumber} rule=${ruleUuid} (PR-level) collapsed ${group.length} findings → 1`,
                    context: this.stageName,
                });
                continue;
            }

            // File-level: keep the most detailed, append "Also found in"
            // list with the other locations.
            const sorted = [...group].sort(
                (a, b) =>
                    (b.suggestionContent?.length || 0) -
                    (a.suggestionContent?.length || 0),
            );
            const keep = { ...sorted[0] };
            const otherLocations: string[] = [];
            const keptLocation = `${keep.relevantFile}:${keep.relevantLinesStart ?? '?'}-${keep.relevantLinesEnd ?? '?'}`;

            for (let i = 1; i < sorted.length; i++) {
                const dup = sorted[i];
                const loc = `${dup.relevantFile}:${dup.relevantLinesStart ?? '?'}-${dup.relevantLinesEnd ?? '?'}`;
                if (loc !== keptLocation && !otherLocations.includes(loc)) {
                    otherLocations.push(loc);
                }
            }

            if (otherLocations.length > 0) {
                const locationsList = otherLocations
                    .map((loc) => `- \`${loc}\``)
                    .join('\n');
                keep.suggestionContent = `${keep.suggestionContent}\n\n**Also found in:**\n${locationsList}`;
            }

            this.logger.log({
                message: `[KODY-DEDUP] PR#${prNumber} rule=${ruleUuid} (file-level) collapsed ${group.length} findings → 1 with ${otherLocations.length} extra locations`,
                context: this.stageName,
            });
            result.push(keep);
        }

        return result;
    }

    /**
     * Deduplicate suggestions that describe the same issue using LLM.
     * Groups by file, then asks Gemini Flash which suggestions are duplicates.
     */
    private async deduplicateSuggestions(
        suggestions: Partial<CodeSuggestion>[],
        prNumber: number,
        byokConfig?: any,
        telemetryMeta?: LangfuseTelemetryMetadata,
    ): Promise<{
        suggestions: Partial<CodeSuggestion>[];
        trace: DedupTraceSummary;
    }> {
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
                        this.summarizeDedupSuggestion(suggestion),
                    ),
                },
            };
        }

        // Model resolution: Google AI key → BYOK via withStructuredOutputFallback → skip dedup
        const googleKey =
            process.env.API_GOOGLE_AI_API_KEY ||
            process.env.GOOGLE_GENERATIVE_AI_API_KEY;

        try {
            // Build summaries with file + lines for cross-file comparison
            const summaries = suggestions
                .map(
                    (s, i) =>
                        `[${i}] ${s.relevantFile || 'unknown'}:${s.relevantLinesStart}-${s.relevantLinesEnd} [${s.label || 'unknown'}/${this.normalizeSeverity(s.severity)}]: ${s.oneSentenceSummary || s.suggestionContent?.substring(0, 200)}${s.improvedCode ? `\n    fix: ${s.improvedCode.substring(0, 100)}` : ''}`,
                )
                .join('\n');

            const runDedup = (model: any) =>
                tracedGenerateText({
                    model: model as any,
                    experimental_telemetry: buildLangfuseTelemetry(
                        'dedup-suggestions',
                        telemetryMeta,
                    ),
                    output: Output.object({
                        schema: jsonSchema({
                            type: 'object',
                            properties: {
                                groups: {
                                    type: 'array',
                                    description:
                                        'Groups of suggestions. Each group has a representative and its duplicates.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            keep: {
                                                type: 'number',
                                                description:
                                                    'Index of the best suggestion to keep as representative',
                                            },
                                            duplicates: {
                                                type: 'array',
                                                items: { type: 'number' },
                                                description:
                                                    'Indices of duplicate suggestions (same bug, same or different locations)',
                                            },
                                        },
                                        required: ['keep', 'duplicates'],
                                        additionalProperties: false,
                                    },
                                },
                                unique: {
                                    type: 'array',
                                    items: { type: 'number' },
                                    description:
                                        'Indices of suggestions that have no duplicates',
                                },
                            },
                            required: ['groups', 'unique'],
                            additionalProperties: false,
                        }),
                    }) as any,
                    prompt: `You have ${suggestions.length} code review suggestions across multiple files in a PR. Identify duplicates and group them.

BE CONSERVATIVE — when in doubt, do NOT group. Only group when you are highly confident they describe the exact same bug.

There are TWO types of duplicates:

1. **EXACT DUPLICATES** (same bug, same location): Multiple suggestions pointing to the same file and overlapping lines describing the same issue. Keep the one with the most detail, discard the rest.

2. **CROSS-LOCATION DUPLICATES** (same bug pattern, different locations): Suggestions describing the EXACT SAME code pattern/bug but applied in different files (e.g., "forEach with async callback" found in 3 different files, or "missing null check on the same API call" in 2 files). These should be GROUPED — keep the best one as representative, list the others as duplicates.

NOT duplicates (keep both):
- Different bugs in the same file or nearby lines (e.g., "nil pointer" and "missing validation" in the same controller — these are DIFFERENT bugs)
- Different root causes even if they sound similar (e.g., "add nil check" vs "fix typo" — different problems)
- Suggestions about different code even if the description sounds similar

IGNORE the category label (bug/security/performance) when deciding — two agents can independently find the same issue.
Prefer keeping the suggestion with the most detail or clearest fix as the representative.

${summaries}`,
                });

            let dedupResult: any;
            if (googleKey) {
                const { createGoogleGenerativeAI } =
                    await import('@ai-sdk/google');
                const model = createGoogleGenerativeAI({ apiKey: googleKey })(
                    'gemini-3-flash-preview',
                );
                dedupResult = await runDedup(model);
            } else {
                dedupResult = await withStructuredOutputFallback(
                    {
                        byokConfig,
                        organizationId: telemetryMeta?.organizationId,
                        label: 'dedup-suggestions',
                    },
                    runDedup,
                );
            }

            // Track token usage
            try {
                const dedupUsage = dedupResult.usage ?? dedupResult.totalUsage;
                if (dedupUsage) {
                    await this.observabilityService.runInSpan(
                        'dedup-suggestions',
                        async () => dedupResult,
                        {
                            'gen_ai.usage.input_tokens':
                                dedupUsage.inputTokens ?? 0,
                            'gen_ai.usage.output_tokens':
                                dedupUsage.outputTokens ?? 0,
                            'gen_ai.usage.total_tokens':
                                dedupUsage.totalTokens ??
                                (dedupUsage.inputTokens ?? 0) +
                                    (dedupUsage.outputTokens ?? 0),
                            'gen_ai.response.model': 'internal-dedup',
                            'gen_ai.run.name': 'code-review-dedup',
                            'type': 'system',
                            'prNumber': prNumber,
                        },
                    );
                }
            } catch {
                // Observability is best-effort
            }

            const dedupOutput =
                (dedupResult as any).object ?? (dedupResult as any).output;

            this.logger.log({
                message: `[DEDUP-DEBUG] PR#${prNumber}: input=${suggestions.length}, groups=${dedupOutput?.groups?.length ?? 0}, unique=${dedupOutput?.unique?.length ?? 0}`,
                context: this.stageName,
            });

            const groups: Array<{
                keep: number;
                duplicates: number[];
            }> = dedupOutput?.groups || [];
            const unique: number[] = dedupOutput?.unique || [];

            // Safety: if LLM returns nothing useful, keep all
            if (groups.length === 0 && unique.length === 0) {
                this.logger.warn({
                    message: `[DEDUP] PR#${prNumber}: LLM returned empty result, keeping all ${suggestions.length} suggestions`,
                    context: this.stageName,
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
                            this.summarizeDedupSuggestion(suggestion),
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
                    uniqueSuggestions.push(
                        this.summarizeDedupSuggestion(suggestions[idx]),
                    );
                }
            }

            // Process groups
            for (const group of groups) {
                const keepIdx = group.keep;
                const dupIndices = group.duplicates || [];

                if (!Number.isInteger(keepIdx) || keepIdx < 0 || keepIdx >= suggestions.length) {
                    // Layer 2: keep is invalid — preserve valid duplicates as independent results
                    for (const dupIdx of dupIndices) {
                        classifiedIndices.add(dupIdx);
                        if (Number.isInteger(dupIdx) && dupIdx >= 0 && dupIdx < suggestions.length && !addedIndices.has(dupIdx)) {
                            indexToResult.set(dupIdx, result.length);
                            result.push(suggestions[dupIdx]);
                            addedIndices.add(dupIdx);
                            uniqueSuggestions.push(
                                this.summarizeDedupSuggestion(suggestions[dupIdx]),
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
                            if (Number.isInteger(dupIdx) && dupIdx >= 0 && dupIdx < suggestions.length) {
                                classifiedIndices.add(dupIdx);
                                const dup = suggestions[dupIdx];
                                const loc = `${dup.relevantFile}:${dup.relevantLinesStart}-${dup.relevantLinesEnd}`;
                                const keptLoc = `${suggestions[keepIdx].relevantFile}:${suggestions[keepIdx].relevantLinesStart}-${suggestions[keepIdx].relevantLinesEnd}`;
                                if (loc !== keptLoc) {
                                    locations.push(loc);
                                }
                            }
                        }
                        if (locations.length > 0) {
                            const existing = result[existingIdx];
                            const locList = locations.map((l) => `- \`${l}\``).join('\n');
                            existing.suggestionContent = `${existing.suggestionContent}\n\n**Also found in:**\n${locList}`;
                        }
                    } else {
                        for (const dupIdx of dupIndices) {
                            if (Number.isInteger(dupIdx) && dupIdx >= 0 && dupIdx < suggestions.length) {
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
                    if (!Number.isInteger(dupIdx) || dupIdx < 0 || dupIdx >= suggestions.length) {
                        continue;
                    }
                    classifiedIndices.add(dupIdx);
                    const dup = suggestions[dupIdx];
                    duplicateSummaries.push(this.summarizeDedupSuggestion(dup));
                    const dupLocation = `${dup.relevantFile}:${dup.relevantLinesStart}-${dup.relevantLinesEnd}`;
                    const keptLocation = `${kept.relevantFile}:${kept.relevantLinesStart}-${kept.relevantLinesEnd}`;

                    if (dupLocation !== keptLocation) {
                        otherLocations.push(dupLocation);
                    }

                    this.logger.log({
                        message: `[DEDUP-REMOVED] PR#${prNumber} ${dup.relevantFile}:${dup.relevantLinesStart}-${dup.relevantLinesEnd} [${dup.label}/${dup.severity}] "${dup.oneSentenceSummary || dup.suggestionContent?.substring(0, 80)}"`,
                        context: this.stageName,
                    });
                }

                // Append other locations to the suggestion content
                if (otherLocations.length > 0) {
                    const locationsList = otherLocations
                        .map((loc) => `- \`${loc}\``)
                        .join('\n');
                    kept.suggestionContent = `${kept.suggestionContent}\n\n**Also found in:**\n${locationsList}`;
                }

                groupSummaries.push({
                    keep: this.summarizeDedupSuggestion(kept),
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
                    uniqueSuggestions.push(
                        this.summarizeDedupSuggestion(suggestions[i]),
                    );
                }
            }

            const totalRemoved = suggestions.length - result.length;
            if (totalRemoved > 0) {
                this.logger.log({
                    message: `[DEDUP] PR#${prNumber}: ${suggestions.length} → ${result.length} (removed ${totalRemoved} duplicates, ${groups.length} groups merged)`,
                    context: this.stageName,
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
                    groups: groupSummaries,
                    unique: uniqueSuggestions,
                },
            };
        } catch (error) {
            const noModel = error instanceof NoStructuredFallbackModelError;
            if (noModel) {
                this.logger.warn({
                    message: `[DEDUP] PR#${prNumber}: No model available for dedup (no Google key and no BYOK), keeping all ${suggestions.length} suggestions`,
                    context: this.stageName,
                });
            } else {
                this.logger.error({
                    message: `[DEDUP] PR#${prNumber}: Failed, keeping all ${suggestions.length} suggestions`,
                    context: this.stageName,
                    error,
                });
            }
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
                    errorMessage: noModel
                        ? 'No model available for dedup (no Google key and no BYOK)'
                        : error instanceof Error
                          ? error.message
                          : String(error),
                    unique: suggestions.map((suggestion) =>
                        this.summarizeDedupSuggestion(suggestion),
                    ),
                },
            };
        }
    }

    /**
     * Creates a callback that writes agent progress to the PR timeline.
     * Each agent gets its own timeline entry (visibility: secondary).
     * Tool calls are batched — updates happen every 5 steps, not every call.
     */
    private createAgentProgressCallback(
        executionUuid: string | undefined,
        prNumber: number | undefined,
        repositoryId: string | undefined,
    ): (event: AgentProgressEvent) => void {
        // Track accumulated tool calls per agent for the final entry
        const agentToolCalls = new Map<
            string,
            Array<{ tool: string; args: string }>
        >();

        return (event: AgentProgressEvent) => {
            const stageName = this.getAgentStageName(event);
            const label = this.formatAgentLabel(event);

            // Fire-and-forget — don't block the agent loop
            this.writeAgentTrace(
                executionUuid,
                prNumber,
                repositoryId,
                stageName,
                event,
                label,
                agentToolCalls,
            ).catch(() => {
                // Best effort — don't fail the review if timeline write fails
            });
        };
    }

    private getAgentStageName(event: AgentProgressEvent): string {
        const baseName =
            event.agentCategory ||
            event.agentName.replace('kodus-', '').replace('-review-agent', '');

        if (
            event.agentReplicaTotal &&
            event.agentReplicaTotal > 1 &&
            event.agentReplicaIndex
        ) {
            return `AgentReview::${baseName}-r${event.agentReplicaIndex}`;
        }

        return `AgentReview::${baseName}`;
    }

    private formatAgentLabel(event: AgentProgressEvent): string {
        const name =
            event.agentCategory ||
            event.agentName.replace('kodus-', '').replace('-review-agent', '');
        const icon =
            name === 'bug'
                ? 'Bug'
                : name === 'security'
                  ? 'Security'
                  : name === 'generalist'
                    ? 'Generalist'
                    : name === 'rules'
                      ? 'Rules'
                      : name === 'kody_rules'
                        ? 'Rules'
                        : 'Performance';
        const replicaSuffix =
            event.agentReplicaTotal &&
            event.agentReplicaTotal > 1 &&
            event.agentReplicaIndex
                ? ` #${event.agentReplicaIndex}/${event.agentReplicaTotal}`
                : '';

        const duration = event.durationMs
            ? `in ${Math.round(event.durationMs / 1000)}s`
            : '';

        // Batch suffix appears whenever the parent agent split the PR into
        // multiple token-budget batches, so the timeline shows e.g.
        // "Generalist Agent — batch 2/3 · step 5, 3 tool calls".
        const batchSuffix =
            event.batchTotal && event.batchTotal > 1 && event.batchIndex
                ? ` — batch ${event.batchIndex}/${event.batchTotal}`
                : '';

        switch (event.status) {
            case 'started':
                return `${icon} Agent${replicaSuffix} — investigating...`;
            case 'batch_started':
                return `${icon} Agent${replicaSuffix}${batchSuffix} — starting (${event.batchFiles ?? 0} files)`;
            case 'batch_completed':
                return `${icon} Agent${replicaSuffix}${batchSuffix} — ${event.findings ?? 0} findings ${duration}`;
            case 'investigating':
                return `${icon} Agent${replicaSuffix}${batchSuffix} — step ${event.step}, ${event.toolCalls?.length ?? 0} tool calls`;
            case 'completed': {
                const suffix =
                    event.source === 'second-chance'
                        ? ' (recovered via second-chance)'
                        : event.source === 'generate-object'
                          ? ' (structured by fallback)'
                          : '';
                return `${icon} Agent${replicaSuffix} — ${event.findings ?? 0} findings ${duration}${suffix}`;
            }
            case 'error': {
                if (event.finishReason === 'timeout') {
                    return `${icon} Agent${replicaSuffix}${batchSuffix} — timed out after ${duration} (${event.step ?? 0} steps)`;
                }
                if (event.finishReason === 'max-steps') {
                    return `${icon} Agent${replicaSuffix}${batchSuffix} — hit step limit (${event.step ?? 0} steps, no findings)`;
                }
                // Surface the actual error so users can self-diagnose from
                // the PR logs instead of digging through docker logs.
                // Truncate to keep the label readable — full message is
                // also available via the observer's stage metadata.
                const errSummary = event.errorMessage
                    ? `: ${event.errorMessage.substring(0, 180)}${event.errorMessage.length > 180 ? '…' : ''}`
                    : '';
                const errNameLabel = event.errorName
                    ? ` (${event.errorName})`
                    : '';
                return `${icon} Agent${replicaSuffix}${batchSuffix} — failed ${duration}${errNameLabel}${errSummary}`;
            }
            default:
                return `${icon} Agent${replicaSuffix}`;
        }
    }

    private async writeAgentTrace(
        executionUuid: string | undefined,
        prNumber: number | undefined,
        repositoryId: string | undefined,
        stageName: string,
        event: AgentProgressEvent,
        label: string,
        agentToolCalls: Map<string, Array<{ tool: string; args: string }>>,
    ): Promise<void> {
        if (!executionUuid && !prNumber) {
            return;
        }

        // Accumulate tool calls
        if (event.toolCalls) {
            const existing = agentToolCalls.get(event.agentName) || [];
            existing.push(...event.toolCalls);
            agentToolCalls.set(event.agentName, existing);
        }

        const status =
            event.status === 'completed'
                ? AutomationStatus.SUCCESS
                : event.status === 'error'
                  ? AutomationStatus.ERROR
                  : AutomationStatus.IN_PROGRESS;

        const metadata: Record<string, any> = {
            visibility: 'secondary',
            label,
        };

        // On completion/error, include full tool trace summary
        if (event.status === 'completed' || event.status === 'error') {
            const allCalls = agentToolCalls.get(event.agentName) || [];
            metadata.agentTrace = {
                category: event.agentCategory,
                replicaIndex: event.agentReplicaIndex,
                replicaTotal: event.agentReplicaTotal,
                steps: event.step,
                findings: event.findings,
                durationMs: event.durationMs,
                totalTokens: event.totalTokens,
                toolCalls: allCalls.slice(-30), // Keep last 30 to avoid huge payloads
                toolSummary: this.summarizeToolCalls(allCalls),
                suggestionsPreview: event.suggestionsPreview,
                coverage: event.coverage,
                verification: event.verification,
                anomalies: event.anomalies,
                // Error details surfaced so the UI (or a copy-paste into a
                // bug report) has the failure reason without needing docker
                // logs access.
                ...(event.status === 'error' && {
                    error: {
                        name: event.errorName,
                        message: event.errorMessage,
                        finishReason: event.finishReason,
                    },
                }),
            };
        }

        const filter = executionUuid
            ? { uuid: executionUuid }
            : { pullRequestNumber: prNumber, repositoryId };

        try {
            // First event → create entry. Subsequent events → update existing.
            if (event.status === 'started') {
                await this.automationExecutionService.updateCodeReview(
                    filter,
                    { status },
                    label,
                    stageName,
                    metadata,
                );
            } else {
                // Find existing entry and update it (don't create duplicates)
                const existing = executionUuid
                    ? await this.automationExecutionService.findLatestStageLog(
                          executionUuid,
                          stageName,
                      )
                    : null;

                if (existing) {
                    const updateData: any = {
                        status,
                        message: label,
                        metadata: { ...existing.metadata, ...metadata },
                    };
                    if (
                        status === AutomationStatus.SUCCESS ||
                        status === AutomationStatus.ERROR
                    ) {
                        updateData.finishedAt = new Date();
                    }
                    await this.automationExecutionService.updateStageLog(
                        existing.uuid,
                        updateData,
                    );
                } else if (
                    status === AutomationStatus.SUCCESS ||
                    status === AutomationStatus.ERROR
                ) {
                    // Fallback for terminal events (completed/error) that raced
                    // ahead of 'started', or where 'started' failed to emit.
                    // Without this, the final SUCCESS/ERROR state and agentTrace
                    // metadata would be silently dropped.
                    await this.automationExecutionService.updateCodeReview(
                        filter,
                        { status },
                        label,
                        stageName,
                        metadata,
                    );
                }
                // Non-terminal events (batch_started, investigating, etc.) with
                // no existing record are silently skipped. In chunked mode,
                // batch_started fires before the recursive execute() emits
                // started — both are fire-and-forget, so batch_started's
                // findLatestStageLog may run before started creates the initial
                // record. Creating a fallback here would produce an orphaned
                // IN_PROGRESS record that never gets updated.
            }
        } catch {
            // Best effort
        }
    }

    /**
     * Resolve GitHub token for cross-repo file reading (readReference tool).
     * Uses the same token that was used to clone the repo for the sandbox.
     */
    private async resolveGitHubToken(
        context: CodeReviewPipelineContext,
    ): Promise<string | undefined> {
        try {
            if (context.getFreshCloneParams) {
                const params = await context.getFreshCloneParams();
                return params?.authToken;
            }
        } catch {
            // Best effort — tool just won't be available
        }
        return undefined;
    }

    private summarizeToolCalls(
        calls: Array<{ tool: string; args: string }>,
    ): Record<string, number> {
        const summary: Record<string, number> = {};
        for (const c of calls) {
            summary[c.tool] = (summary[c.tool] || 0) + 1;
        }
        return summary;
    }
}
