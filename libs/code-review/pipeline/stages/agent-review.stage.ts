import * as crypto from 'crypto';

import { createLogger } from '@libs/core/log/logger';
import { Output, jsonSchema, embed, type EmbeddingModel } from 'ai';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { tracedGenerateText } from '@libs/llm/llm-call';
import { resolveAdaptiveProfile } from '@libs/code-review/infrastructure/agents/engine/adaptive-fit';
import { resolveContextWindow } from '@libs/llm/model-context-window';
import {
    DEDUP_SCHEMA,
    DEDUP_CONTENT_THRESHOLD,
    DEDUP_EMBEDDING_LOW,
    DEDUP_EMBEDDING_HIGH,
    DEDUP_TIEBREAK_SCHEMA,
    buildDedupPrompt,
    buildTiebreakPrompt,
    contentSimilarity,
    cosineSimilarity,
    dedupEmbeddingText,
} from '@libs/code-review/infrastructure/agents/engine/dedup-prompt';
import { buildPlatformEmbedder } from '@libs/common/utils/document';
import {
    dedupReviewWarnings,
    type ReviewWarning,
} from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import {
    withStructuredOutputFallback,
    NoStructuredFallbackModelError,
    getModelName,
} from '@libs/llm/byok-to-vercel';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { agentModelIdentity } from '@libs/llm/model-identity';
import { buildKodyRuleLink } from '@libs/code-review/utils/build-kody-rule-link';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
    type LangfuseTelemetryMetadata,
} from '@libs/core/log/langfuse';

import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { ReviewOrchestratorService } from '@libs/code-review/infrastructure/agents/review-orchestrator.service';
import { buildOrchestratorInput } from './build-orchestrator-input';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { FeatureGateService, FEATURE_KEYS } from '@libs/feature-gate';
import {
    ORGANIZATION_SERVICE_TOKEN,
    IOrganizationService,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { AgentProgressEvent } from '@libs/code-review/infrastructure/agents/review-agent.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    LazyLinkedRepoAccess,
    evaluateCrossRepoBoundaryGate,
    findOverrideForRepo,
    parsePrDescriptionOverrides,
    prHeadRefspecForPlatform,
    resolveLinkedRepositories,
    type CrossRepoGateMetadata,
    type LinkedRepoAccess,
    type LinkedRepositoriesReviewMetadata,
} from '@libs/ee/linked-repositories';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import { isTeamsOrEnterpriseTierAllowed } from '@libs/ee/license/tier/teams-or-enterprise-tier-policy';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';

import { GraphContextService } from '@libs/code-review/infrastructure/adapters/services/graph/graph-context.service';
import {
    IRepositoryService,
    REPOSITORY_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/RepositoryService.contract';
import { AstGraphStatus } from '@libs/code-review/infrastructure/adapters/repositories/schemas/repository.model';
import {
    IKodyRule,
    resolveKodyRuleSeverityLevel,
    SeverityLevel,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { KodyRuleSummaryService } from '@libs/kodyRules/infrastructure/adapters/services/kody-rule-summary.service';
import {
    CodeReviewPipelineContext,
    DedupTraceGroupSummary,
    DedupTraceSuggestionSummary,
    DedupTraceSummary,
} from '../context/code-review-pipeline.context';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import {
    LlmErrorCategory,
    classifyLLMError,
    getClassification,
} from '@libs/llm/error-classifier';
import {
    isSecondaryByok,
    resolveSecondaryPassModel,
} from '@libs/code-review/infrastructure/agents/engine/secondary-pass-model';

/**
 * Extract valid line ranges from a unified diff patch.
 * Returns an array of [start, end] tuples representing lines on the RIGHT side
 * that GitHub allows for inline comments.
 *
 * For each hunk, we track which RIGHT-side lines exist (context + added).
 * GitHub only allows comments on lines that appear in the diff.
 */
export function extractValidDiffLines(patch?: string): Array<[number, number]> {
    if (!patch) {
        return [];
    }

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
 *
 * Returns the suggestion clamped to the overlapping hunk when its lines
 * (partially) overlap a changed range. Returns `null` when the suggestion
 * cites concrete lines that do NOT overlap ANY changed hunk — i.e. the
 * finding is about code this PR did not touch. Such findings used to be
 * clamped onto the nearest hunk, which silently re-anchored a comment about
 * unchanged code onto a changed line (false positive on unchanged code).
 * Dropping them keeps the review honest: "only suggest changes on lines
 * present in the diff".
 */
export function snapLinesToDiff(
    suggestion: Partial<CodeSuggestion>,
    validRanges: Array<[number, number]>,
): Partial<CodeSuggestion> | null {
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

    // Find all overlapping ranges and pick the best one (largest overlap).
    // Overlap is measured inclusively (overlapEnd - overlapStart + 1) so a
    // single shared line counts as overlap size 1 — otherwise a finding that
    // sits exactly on one changed line (start === end) would score 0 and be
    // treated as "no overlap" and dropped.
    let bestOverlap: [number, number] | null = null;
    let bestOverlapSize = 0;

    for (const [rs, re] of validRanges) {
        if (start <= re && end >= rs) {
            const overlapStart = Math.max(start, rs);
            const overlapEnd = Math.min(end, re);
            const overlapSize = overlapEnd - overlapStart + 1;
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

    // No overlap with any changed hunk — the finding is about code this PR
    // did not modify. Drop it instead of re-anchoring it onto an unrelated
    // changed line (which produced false positives on unchanged code).
    return null;
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
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        @Inject(REPOSITORY_SERVICE_TOKEN)
        private readonly repositoryService: IRepositoryService,
        private readonly reviewOrchestrator: ReviewOrchestratorService,
        private readonly observabilityService: ObservabilityService,
        private readonly graphContext: GraphContextService,
        private readonly featureGate: FeatureGateService,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
        private readonly codeManagementService: CodeManagementService,
        // Optional: specs construct the stage manually; when absent the
        // review simply runs on the full rule texts.
        @Optional()
        private readonly kodyRuleSummaryService?: KodyRuleSummaryService,
        // Optional so unit tests that don't care about plan tier still compile.
        // Production always wires LicenseService; missing service ⇒ linked
        // repos stay off (fail-closed for the paid feature).
        @Optional()
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService?: ILicenseService,
    ) {
        super();
    }

    /**
     * Review-ready kody rules: lazy-backfill summaries for long rules that
     * lack a valid one (covers rules created before the summary feature), then
     * swap each long rule's text for its summary (sourceHash-guarded — see
     * KodyRuleSummaryService). Any failure falls back to the raw config rules:
     * the review never blocks on summarization. The frozen context is never
     * mutated — callers pass the result via OrchestratorInputComputed.
     */
    private async prepareKodyRulesForReview(
        context: CodeReviewPipelineContext,
    ): Promise<Partial<IKodyRule>[] | undefined> {
        const rules = context.codeReviewConfig?.kodyRules;
        if (!rules?.length || !this.kodyRuleSummaryService) {
            return rules;
        }
        try {
            // Judgment units: atoms > summary > full text (see
            // KodyRuleSummaryService.prepareForReview). Long rules are lazily
            // decomposed into atomic requirements carrying the parent uuid.
            return await this.kodyRuleSummaryService.prepareForReview(
                rules,
                context.organizationAndTeamData,
            );
        } catch (error) {
            this.logger.warn({
                message:
                    '[kody-rule-summary] prepare failed — reviewing with full rule texts',
                context: AgentReviewStage.name,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
            return rules;
        }
    }

    /**
     * Resolve whether HEAVY mode actually runs: the per-review opt-in (CLI
     * `--heavy` / `@kody review --heavy`) AND the `heavy-review` feature gate,
     * which is an ALPHA feature — cloud gates it by the org's release track +
     * PostHog allowlist, self-hosted keeps it off until it's promoted to beta.
     * A denied request degrades silently to a normal review.
     */
    private async resolveHeavy(
        context: CodeReviewPipelineContext,
    ): Promise<boolean> {
        const requested =
            context.heavy || context.codeReviewConfig?.heavy || false;
        if (!requested) {
            return false;
        }
        const org = context.organizationAndTeamData;
        try {
            const releaseTrack = await this.organizationService.getReleaseTrack(
                org.organizationId,
            );
            const enabled = await this.featureGate.isEnabled(
                FEATURE_KEYS.heavyReview,
                {
                    identifier: org.organizationId,
                    organizationAndTeamData: org,
                    releaseTrack,
                },
            );
            if (!enabled) {
                this.logger.log({
                    message: `[AGENT] Heavy review requested but not enabled for org (alpha feature) — running normal review`,
                    context: this.stageName,
                    metadata: { organizationId: org.organizationId },
                });
            }
            return enabled;
        } catch (err) {
            // Fail safe: if the gate can't be evaluated, do NOT silently run the
            // alpha path — degrade to normal.
            this.logger.warn({
                message: `[AGENT] Heavy feature-gate check failed; running normal review`,
                context: this.stageName,
                error: err,
            });
            return false;
        }
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const prNumber = context.pullRequest?.number;
        const changedFiles = context.changedFiles;

        if (!changedFiles?.length) {
            return context;
        }

        // When no sandbox is available (e.g. trial mode, or sandbox provider
        // unavailable), run the agent in "self-contained" mode: no tools,
        // single-shot analysis on the diff content inlined in the user
        // prompt. The orchestrator/agent-loop detect the empty tools case
        // and switch to a self-contained system/user prompt variant.
        //const hasSandbox = !!context.sandboxHandle?.remoteCommands;

        if (!context.sandboxHandle?.remoteCommands) {
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
        const resolvedSlot = context.codeReviewConfig?.resolvedModelSlot;
        // byokModelId (id) wins over the legacy byokModel NAME (D-05). When a
        // byokModelId is set, ValidateConfigStage has already routed the
        // codeReview task to that id-addressed model into the resolved slot
        // (same routing the model factory runs), so the legacy NAME re-apply
        // is skipped here — the id-routed model stands. Only when no id is set
        // does the legacy NAME window still apply the override onto the slot.
        const overrideModel = context.codeReviewConfig?.byokModelId?.trim()
            ? undefined
            : context.codeReviewConfig?.byokModel?.trim();
        const effectiveSlot =
            overrideModel && resolvedSlot
                ? { ...resolvedSlot, model: overrideModel }
                : resolvedSlot;
        // Use the same model-name formatter the agent uses (provider:model)
        // so stage-emitted warnings and agent-emitted warnings share a
        // dedup key. Otherwise dedupReviewWarnings sees them as distinct
        // and the user sees duplicate bullets (PROMPT_COMPACTED listed
        // twice — once with "gemini-2.5-flash" and once with
        // "google_gemini:gemini-2.5-flash"). getModelName is native: it
        // takes the resolved slot directly (no `{main}` wrapping).
        const effectiveModelName = getModelName(effectiveSlot ?? undefined);
        const effectiveContextWindow = resolveContextWindow({
            byokMaxInputTokens: resolvedSlot?.maxInputTokens,
            modelName: overrideModel || resolvedSlot?.model || '',
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

        this.logger.debug({
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

        // Observability for the `@kody review <directive>` steering feature:
        // emit a marker when a directive reached the finder, so it's visible in
        // logs (and assertable in E2E) that the review was actually focused.
        if (context.reviewDirective) {
            this.logger.log({
                message: `[AGENT][review-focus] steering PR#${prNumber} by directive: "${context.reviewDirective}"`,
                context: this.stageName,
                metadata: {
                    prNumber,
                    reviewDirective: context.reviewDirective,
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                },
            });
        }

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
                    if (context.sandboxHandle?.run) {
                        const repo =
                            await this.repositoryService.findByExternalId(
                                context.platformType,
                                String(context.repository?.id || ''),
                            );

                        if (repo?.astGraphStatus === AstGraphStatus.READY) {
                            callGraph = await this.graphContext.generateContext(
                                context.sandboxHandle,
                                changedFiles,
                                repo.uuid,
                            );
                        } else {
                            callGraph =
                                await this.graphContext.generateContextLegacy(
                                    context.sandboxHandle,
                                    changedFiles,
                                    context.sandboxHandle?.baseBranch ||
                                        context.pullRequest?.base?.ref ||
                                        context.repository?.defaultBranch,
                                );
                        }
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
            }

            // Single place that maps context → agent input, extracted to a
            // PURE helper (build-orchestrator-input) so the wiring — notably
            // reviewDirective, an optional field no typecheck would catch if
            // dropped — is unit-testable and can't drift from a second inline
            // copy. A committed merge conflict once kept an inline builder that
            // silently dropped reviewDirective; this is the single source now.
            // Resolve HEAVY once (opt-in AND the alpha feature gate) and write it
            // back onto the context so the SAME gated value flows to both the
            // finder and the persisted PR record (create-file-comments stage).
            const resolvedHeavy = await this.resolveHeavy(context);
            // The pipeline context is Immer-frozen (auto-freeze) once it has
            // passed through an earlier stage's produce(), so a direct
            // `context.heavy = …` throws "Cannot assign to read only property".
            // Write it back through updateContext so the gated value both flows
            // into buildOrchestratorInput below AND persists to the downstream
            // create-file-comments stage.
            context = this.updateContext(context, (draft) => {
                draft.heavy = resolvedHeavy;
            });

            // Deterministic boundary gate (#1576): only arm linked-repo tools
            // + prompt when the diff touches boundary surface. Config alone is
            // not enough — pure internal refactors stay single-repo.
            const { linkedRepoAccess, gateMetadata } =
                await this.resolveLinkedRepoAccessWithGate(
                    context,
                    changedFiles,
                );

            const result = await this.reviewOrchestrator.execute(
                buildOrchestratorInput(context, {
                    changedFiles,
                    prNumber,
                    repositoryId,
                    reviewOptions,
                    onAgentProgress,
                    gitHubToken: await this.resolveGitHubToken(context),
                    callGraph,
                    adaptiveProfile,
                    heavy: resolvedHeavy,
                    kodyRules: await this.prepareKodyRulesForReview(context),
                    linkedRepoAccess,
                }),
            );

            // Snapshot linked-repo metadata after the review so clone status
            // (ready/failed) reflects what the agent actually used. When the
            // gate skips the pass we still record the decision for telemetry.
            if (linkedRepoAccess || gateMetadata) {
                const metadata: LinkedRepositoriesReviewMetadata =
                    linkedRepoAccess?.getMetadata() ?? {
                        configured:
                            context.codeReviewConfig?.linkedRepositories
                                ?.length ?? 0,
                        resolved: 0,
                        cloned: 0,
                        failed: 0,
                        warnings: [],
                        gate: gateMetadata,
                        repositories: [],
                    };
                context = this.updateContext(context, (draft) => {
                    draft.linkedRepositoriesMetadata = metadata;
                });
            }

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

            this.logger.debug({
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
                    if (!draft.errors) {
                        draft.errors = [];
                    }
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

            // An agent that ran out of time or steps did NOT clear the code —
            // it stopped looking. Record it as 'partial' so auto-approve is
            // held back and the check lands on NEUTRAL: degraded, not clean.
            // 'partial' rather than 'critical' because the agent may still have
            // produced real findings before the ceiling; what we can't claim is
            // completeness. Core agents only — kody-rules is auxiliary and its
            // truncation shouldn't gate the whole review.
            for (const cut of result.incomplete || []) {
                if (!CRITICAL_AGENTS.has(cut.agentName)) {
                    continue;
                }

                context = this.updateContext(context, (draft) => {
                    if (!draft.errors) {
                        draft.errors = [];
                    }
                    draft.errors.push({
                        pipelineId: context.pipelineMetadata?.pipelineId,
                        stage: this.stageName,
                        substage: `agent:${cut.agentName}`,
                        error: new Error(
                            `Agent "${cut.agentName}" stopped at its ${cut.finishReason} limit after ${cut.durationMs}ms — the review did not complete`,
                        ),
                        severity: 'partial',
                        metadata: {
                            agentName: cut.agentName,
                            category: cut.category,
                            finishReason: cut.finishReason,
                            suggestionsFound: cut.suggestionsFound,
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
                    typeof context.codeReviewConfig?.resolvedModelSlot
                        ?.provider === 'string'
                        ? (context.codeReviewConfig.resolvedModelSlot
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
                        LlmErrorCategory.UNKNOWN;
                    const bMapped =
                        classifyFailure(b).category !==
                        LlmErrorCategory.UNKNOWN;
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

                this.logger.debug({
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
            // A finding whose cited lines don't overlap ANY changed hunk is dropped
            // (snapLinesToDiff returns null) rather than clamped onto an unrelated
            // changed line — clamping was re-anchoring comments about UNCHANGED code
            // onto the diff and shipping them as false positives.
            const changedFilesByName = new Map(
                changedFiles.map((f) => [f.filename, f]),
            );
            const validatedSuggestions = result.suggestions
                .map((s) => {
                    const file = changedFilesByName.get(s.relevantFile);
                    if (!file) return s;
                    const validRanges = extractValidDiffLines(file.patch);
                    const snapped = snapLinesToDiff(s, validRanges);
                    if (snapped === null) {
                        this.logger.log({
                            message: `[AGENT] Dropped out-of-diff suggestion for ${s.relevantFile}: lines ${s.relevantLinesStart}-${s.relevantLinesEnd} do not overlap any changed hunk`,
                            context: this.stageName,
                        });
                        allDiscarded.push({
                            ...s,
                            priorityStatus:
                                PriorityStatus.DISCARDED_BY_CODE_DIFF,
                        });
                        return null;
                    }
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
                })
                .filter((s): s is Partial<CodeSuggestion> => s !== null);

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
                    context.codeReviewConfig?.resolvedModelSlot,
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

            // Cross-stream dedup (PR #1527 follow-up): a file-scope Kody Rule and
            // an AI suggestion can flag the same issue on the same file. They are
            // deduped in separate streams above, so both survive. Absorb the
            // suggestion into the Kody Rule when they describe the same bug (the
            // rule wins — it's user-configured and carries the violation link).
            try {
                dedupedNonRules =
                    await this.crossDedupSuggestionsAgainstKodyRules(
                        dedupedNonRules,
                        kodyRulesForDedup,
                        prNumber,
                        context.codeReviewConfig?.byokConfig,
                        telemetryMeta,
                    );
            } catch (crossErr) {
                this.logger.warn({
                    message: `[DEDUP-CROSS] PR#${prNumber}: cross-stream dedup failed, keeping all`,
                    context: this.stageName,
                    error: crossErr,
                });
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
                } = require('@libs/code-review/infrastructure/agents/engine/classify-severity');
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
                } = require('@libs/code-review/infrastructure/agents/engine/format-suggestion-content');
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
                        // Keep llmPrompt in sync with the formatted prose.
                        // llmPrompt is a snapshot of the RAW suggestionContent
                        // (WHAT/WHY/HOW) taken in finding-mapper before this
                        // pass; the per-comment "Prompt for LLM" copy block and
                        // the consolidated @agentPrompt read it, so without this
                        // the raw scaffolding still leaks there.
                        deduped[i].llmPrompt = fmt.suggestionContent;
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

            const stageError =
                error instanceof Error ? error : new Error(String(error));
            const classification =
                getClassification(stageError) ??
                classifyLLMError(
                    stageError,
                    typeof context.codeReviewConfig?.resolvedModelSlot
                        ?.provider === 'string'
                        ? context.codeReviewConfig.resolvedModelSlot.provider
                        : undefined,
                );

            // Keep going so the end-review comment still gets posted and the
            // check still finalizes — but record the failure as CRITICAL. This
            // catch used to return empty results silently, which downstream
            // read as "the agent found nothing", auto-approving the PR and
            // reporting SUCCESS on a review that never happened (#1568). The
            // per-agent failures the orchestrator reports are recorded above;
            // this covers everything that throws before or after that point.
            return this.updateContext(context, (draft) => {
                draft.fileAnalysisResults = [];
                if (!draft.errors) {
                    draft.errors = [];
                }
                draft.errors.push({
                    pipelineId: context.pipelineMetadata?.pipelineId,
                    stage: this.stageName,
                    error: stageError,
                    severity: 'critical',
                    metadata: { prNumber, durationMs },
                });

                if (!draft.lastReviewError) {
                    draft.lastReviewError = {
                        category: classification.category,
                        provider: classification.provider,
                        friendlyMessage: classification.friendlyMessage,
                        occurredAt: new Date(),
                    };
                }
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

    /** Embed a suggestion's description once per dedup run (memoized by index).
     * Fail-soft: no platform embedding key or any error → null, so the caller
     * falls back to the pre-#1527 lexical behavior (veto) instead of crashing. */
    /**
     * Embedder for the dedup semantic tier. HARDCODED to OpenAI: text-embedding
     * models are OpenAI's, so this must NEVER go through the client's BYOK
     * provider nor inherit a forced base URL (e.g. a Moonshot/OpenAI-compatible
     * override in the env) — those don't serve text-embedding-3-small. The
     * base URL is pinned explicitly; only the platform key comes from the env.
     * (The tiebreak LLM that runs AFTER the embedding still uses BYOK.)
     */
    private dedupEmbedder: EmbeddingModel | null | undefined;
    private getDedupEmbedder(): EmbeddingModel | null {
        if (this.dedupEmbedder !== undefined) {
            return this.dedupEmbedder;
        }
        // Single platform-embedder seam (libs/common/utils/document): pinned to
        // OpenAI text-embedding, never BYOK, null when no platform key.
        this.dedupEmbedder = buildPlatformEmbedder();
        return this.dedupEmbedder;
    }

    private async embedDedupSuggestion(
        suggestion: Partial<CodeSuggestion>,
        key: string,
        cache: Map<string, number[] | null>,
    ): Promise<number[] | null> {
        if (cache.has(key)) {
            return cache.get(key) ?? null;
        }
        let vector: number[] | null = null;
        try {
            const text = dedupEmbeddingText(suggestion as any);
            const embedder = this.getDedupEmbedder();
            if (text && embedder) {
                const { embedding } = await embed({
                    model: embedder,
                    value: text,
                });
                vector = embedding;
            }
        } catch (err) {
            this.logger.warn({
                message: `[DEDUP-GUARD] embedding unavailable, falling back to lexical veto`,
                context: this.stageName,
                error: err,
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
     * Every external failure (no embed key, embedding/LLM error) falls back to a
     * veto — the exact pre-#1527 behavior — so a low-overlap merge is never
     * honored blindly.
     *
     * `crossStream` mode (Kody-Rule vs suggestion): there is NO prior LLM
     * grouping to corroborate a match, so the cheap lexical-honor shortcut is
     * skipped — only a strong semantic signal (embedding-high or a tiebreak yes)
     * may absorb a suggestion into a rule, keeping false absorptions near zero.
     */
    private async resolveDedupMerge(
        dup: Partial<CodeSuggestion>,
        keep: Partial<CodeSuggestion>,
        dupKey: string,
        keepKey: string,
        embedCache: Map<string, number[] | null>,
        tiebreak: (
            a: Partial<CodeSuggestion>,
            b: Partial<CodeSuggestion>,
        ) => Promise<boolean | null>,
        opts?: { crossStream?: boolean },
    ): Promise<{ honor: boolean; reason: string; score: number }> {
        const lexical = contentSimilarity(dup, keep);
        if (!opts?.crossStream && lexical >= DEDUP_CONTENT_THRESHOLD) {
            return { honor: true, reason: 'lexical', score: lexical };
        }

        const [vecDup, vecKeep] = await Promise.all([
            this.embedDedupSuggestion(dup, dupKey, embedCache),
            this.embedDedupSuggestion(keep, keepKey, embedCache),
        ]);
        if (!vecDup || !vecKeep) {
            return { honor: false, reason: 'lexical-veto (no-embed)', score: lexical };
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
    private buildDedupTiebreak(
        byokConfig: NormalizedModel | undefined,
        telemetryMeta: LangfuseTelemetryMetadata | undefined,
        prNumber: number,
    ): (
        a: Partial<CodeSuggestion>,
        b: Partial<CodeSuggestion>,
    ) => Promise<boolean | null> {
        const secondaryByok = isSecondaryByok(byokConfig);
        return async (a, b) => {
            try {
                const call = (model: any) =>
                    tracedGenerateText({
                        model: model as any,
                        ...toAiSdkTelemetryArgs(
                            buildLangfuseTelemetry(
                                'dedup-tiebreak',
                                telemetryMeta,
                            ),
                        ),
                        output: Output.object({
                            schema: jsonSchema(DEDUP_TIEBREAK_SCHEMA as any),
                        }) as any,
                        prompt: buildTiebreakPrompt(a as any, b as any),
                    });
                const res = await withStructuredOutputFallback(
                    {
                        slot: secondaryByok ? byokConfig : undefined,
                        organizationId: telemetryMeta?.organizationId,
                        label: 'dedup-tiebreak',
                    },
                    call,
                );
                const out = (res as any).object ?? (res as any).output;
                return typeof out?.sameBug === 'boolean' ? out.sameBug : null;
            } catch (err) {
                this.logger.warn({
                    message: `[DEDUP-GUARD] PR#${prNumber}: tiebreak failed, vetoing merge`,
                    context: this.stageName,
                    error: err,
                });
                return null;
            }
        };
    }

    /**
     * Cross-stream dedup (PR #1527 follow-up): a Kody Rule and an AI suggestion
     * can flag the SAME issue on the same file, but they are deduped in separate
     * streams so both survive. Here we cross-compare FILE-scope Kody Rules
     * against the already-deduped suggestions; when they describe the same bug we
     * drop the suggestion and keep the Kody Rule (it is user-configured and
     * carries the rule-violation link). PR-scope rules (no relevantFile) are
     * excluded — they are not tied to a file/line. Fail-soft: any error keeps the
     * suggestion (pre-change behavior).
     */
    private async crossDedupSuggestionsAgainstKodyRules(
        suggestions: Partial<CodeSuggestion>[],
        kodyRules: Partial<CodeSuggestion>[],
        prNumber: number,
        byokConfig?: NormalizedModel,
        telemetryMeta?: LangfuseTelemetryMetadata,
    ): Promise<Partial<CodeSuggestion>[]> {
        const fileScopedRules = kodyRules.filter((r) => !!r.relevantFile);
        if (!suggestions.length || !fileScopedRules.length) {
            return suggestions;
        }

        const embedCache = new Map<string, number[] | null>();
        const tiebreak = this.buildDedupTiebreak(
            byokConfig,
            telemetryMeta,
            prNumber,
        );

        const kept: Partial<CodeSuggestion>[] = [];
        for (let si = 0; si < suggestions.length; si++) {
            const s = suggestions[si];
            let absorbedBy: { ri: number; reason: string; score: number } | null =
                null;
            for (let ri = 0; ri < fileScopedRules.length; ri++) {
                const rule = fileScopedRules[ri];
                // A suggestion can only duplicate a rule on the SAME file.
                if (rule.relevantFile !== s.relevantFile) {
                    continue;
                }
                const decision = await this.resolveDedupMerge(
                    s,
                    rule,
                    `s${si}`,
                    `r${ri}`,
                    embedCache,
                    tiebreak,
                    { crossStream: true },
                );
                if (decision.honor) {
                    absorbedBy = {
                        ri,
                        reason: decision.reason,
                        score: decision.score,
                    };
                    break;
                }
            }
            if (absorbedBy) {
                this.logger.log({
                    message: `[DEDUP-CROSS] PR#${prNumber}: suggestion ${s.relevantFile}:${s.relevantLinesStart}-${s.relevantLinesEnd} [${s.label}] absorbed by kody rule (${absorbedBy.reason}, score=${absorbedBy.score.toFixed(3)})`,
                    context: this.stageName,
                });
            } else {
                kept.push(s);
            }
        }
        return kept;
    }

    /**
     * Deduplicate suggestions that describe the same issue using LLM.
     * Groups by file, then asks Gemini Flash which suggestions are duplicates.
     */
    private async deduplicateSuggestions(
        suggestions: Partial<CodeSuggestion>[],
        prNumber: number,
        resolvedSlot?: NormalizedModel,
        telemetryMeta?: LangfuseTelemetryMetadata,
    ): Promise<{
        suggestions: Partial<CodeSuggestion>[];
        trace: DedupTraceSummary;
    }> {
        // The secondary-pass gate helpers (isSecondaryByok /
        // resolveSecondaryPassModel) and withStructuredOutputFallback all take
        // the bare resolved model slot directly.
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
                        this.summarizeDedupSuggestion(suggestion),
                    ),
                },
            };
        }

        // Model resolution (same policy as severity/format):
        //   BYOK main → withStructuredOutputFallback (client key + schema retry)
        //   else the Kodus-funded DeepSeek default / self-hosted env model
        //   (getInternalModel — trial / no BYOK)
        const secondaryByok = isSecondaryByok(dedupSlot);

        try {
            const runDedup = (model: any) =>
                tracedGenerateText({
                    model: model as any,
                    ...toAiSdkTelemetryArgs(
                        buildLangfuseTelemetry(
                            'dedup-suggestions',
                            telemetryMeta,
                        ),
                    ),
                    output: Output.object({
                        schema: jsonSchema(DEDUP_SCHEMA as any),
                    }) as any,
                    prompt: buildDedupPrompt(suggestions, (sev) =>
                        this.normalizeSeverity(sev),
                    ),
                });

            let dedupResult: any;
            if (secondaryByok) {
                // The resolved codeReview slot is the secondary model, passed
                // through as the bare slot.
                dedupResult = await withStructuredOutputFallback(
                    {
                        slot: resolvedSlot,
                        organizationId: telemetryMeta?.organizationId,
                        label: 'dedup-suggestions',
                    },
                    runDedup,
                );
            } else {
                // Trial / no-BYOK / self-hosted env path. Still wrap with
                // withStructuredOutputFallback so models that reject
                // response_format=json_schema (Gemini, some proxies) retry
                // with json_object instead of failing open into keep-all
                // after a thrown error further up — or worse, partial
                // structured output that leaves true dups on the PR.
                if (!resolveSecondaryPassModel(dedupSlot)) {
                    this.logger.warn({
                        message: `[DEDUP] PR#${prNumber}: no secondary model available, keeping all suggestions`,
                        context: this.stageName,
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
                                this.summarizeDedupSuggestion(suggestion),
                            ),
                        },
                    };
                }
                dedupResult = await withStructuredOutputFallback(
                    {
                        slot: resolvedSlot,
                        organizationId: telemetryMeta?.organizationId,
                        label: 'dedup-suggestions',
                    },
                    runDedup,
                );
            }

            // Track token usage — via the canonical emitter so the dedup pass'
            // cost lands in `observability_telemetry` with the SAME schema
            // (agentName/phase/type/gen_ai.usage.*) as the review agents.
            const dedupUsage = dedupResult.usage ?? dedupResult.totalUsage;
            if (dedupUsage) {
                await this.observabilityService.recordAgentRunUsage({
                    agentName: 'code-review',
                    phase: 'dedup',
                    spanName: 'dedup-suggestions',
                    runName: 'code-review-dedup',
                    // Identity from the ONE derivation: BYOK slot when the dedup
                    // ran on the org's key, else undefined → the env/managed
                    // default name (getModelName), not a placeholder.
                    ...agentModelIdentity(
                        secondaryByok ? resolvedSlot : undefined,
                    ),
                    usage: {
                        inputTokens: dedupUsage.inputTokens,
                        outputTokens: dedupUsage.outputTokens,
                        totalTokens: dedupUsage.totalTokens,
                    },
                    prNumber,
                });
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

            // Semantic tier of the content guard (PR #1527): when lexical overlap
            // is inconclusive we compare description embeddings, and only escalate
            // the ambiguous band to a focused LLM tiebreak. Embeddings are memoized
            // per suggestion for this dedup run.
            const embedCache = new Map<string, number[] | null>();
            const runTiebreak = this.buildDedupTiebreak(
                dedupSlot,
                telemetryMeta,
                prNumber,
            );

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
                if (
                    Number.isInteger(idx) &&
                    idx >= 0 &&
                    idx < suggestions.length
                ) {
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
                                this.summarizeDedupSuggestion(
                                    suggestions[dupIdx],
                                ),
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
                                const loc = `${dup.relevantFile}:${dup.relevantLinesStart}-${dup.relevantLinesEnd}`;
                                const keptLoc = `${suggestions[keepIdx].relevantFile}:${suggestions[keepIdx].relevantLinesStart}-${suggestions[keepIdx].relevantLinesEnd}`;
                                if (loc !== keptLoc) {
                                    locations.push(loc);
                                }
                            }
                        }
                        if (locations.length > 0) {
                            const existing = result[existingIdx];
                            const locList = locations
                                .map((l) => `- \`${l}\``)
                                .join('\n');
                            existing.suggestionContent = `${existing.suggestionContent}\n\n**Also found in:**\n${locList}`;
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
                    const decision = await this.resolveDedupMerge(
                        suggestions[dupIdx],
                        suggestions[keepIdx],
                        `n${dupIdx}`,
                        `n${keepIdx}`,
                        embedCache,
                        runTiebreak,
                    );
                    if (!decision.honor) {
                        // The model grouped these as duplicates but the guard is
                        // not confident they are the same bug, so we keep both.
                        // Log it — otherwise this veto is invisible in production
                        // (the silent-degradation family from PR #1527).
                        this.logger.log({
                            message: `[DEDUP-GUARD] PR#${prNumber}: merge of idx ${dupIdx} into ${keepIdx} rejected (${decision.reason}, score=${decision.score.toFixed(3)})`,
                            context: this.stageName,
                        });
                        classifiedIndices.add(dupIdx);
                        if (!addedIndices.has(dupIdx)) {
                            addedIndices.add(dupIdx);
                            indexToResult.set(dupIdx, result.length);
                            result.push(suggestions[dupIdx]);
                            uniqueSuggestions.push(
                                this.summarizeDedupSuggestion(
                                    suggestions[dupIdx],
                                ),
                            );
                        }
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
            // Fail loud outside production. An unexpected error here (e.g. the
            // `googleKey` ReferenceError that shipped on a feature branch) is a
            // programming bug — left to the graceful 'failed-keep-all' path it
            // ships silently as duplicate comments. In dev/CI/test we re-throw
            // so it surfaces at PR time; the operational "no model available"
            // case (noModel) stays graceful everywhere.
            const isProduction =
                (process.env.API_NODE_ENV || process.env.NODE_ENV) ===
                'production';
            if (!noModel && !isProduction) {
                throw error;
            }
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
            );
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
                // Prefer the classified sentence ("The configured model is not
                // available on the provider…") over the raw provider string,
                // which is often a bare status phrase like "Not Found" that
                // tells the user nothing. Class name and raw text stay in the
                // stage metadata for whoever needs to debug.
                const reason =
                    event.errorFriendlyMessage ||
                    (event.errorMessage
                        ? `${event.errorName ? `${event.errorName}: ` : ''}${event.errorMessage.substring(0, 180)}${event.errorMessage.length > 180 ? '…' : ''}`
                        : '');
                const errSummary = reason ? ` — ${reason}` : '';
                return `${icon} Agent${replicaSuffix}${batchSuffix} — failed ${duration}${errSummary}`;
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

    /**
     * Whether the org may use linked repositories (Teams / Enterprise / trial).
     * Fail-closed: missing license service or validation errors deny the feature
     * without failing the rest of the review.
     */
    private async isLinkedRepositoriesPlanAllowed(
        organizationAndTeamData: CodeReviewPipelineContext['organizationAndTeamData'],
    ): Promise<boolean> {
        if (!this.licenseService) {
            return false;
        }
        try {
            const license =
                await this.licenseService.validateOrganizationLicense(
                    organizationAndTeamData,
                );
            return isTeamsOrEnterpriseTierAllowed(license);
        } catch (error) {
            this.logger.warn({
                message:
                    'linkedRepositories plan check failed — treating as not allowed',
                context: this.stageName,
                metadata: {
                    organizationId: organizationAndTeamData?.organizationId,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
            return false;
        }
    }

    /**
     * Run the deterministic boundary gate, then (only if it fires) build
     * lazy linked-repo access. Gate-off still returns metadata so the
     * review can record "configured but skipped".
     */
    private async resolveLinkedRepoAccessWithGate(
        context: CodeReviewPipelineContext,
        changedFiles: CodeReviewPipelineContext['changedFiles'],
    ): Promise<{
        linkedRepoAccess: LinkedRepoAccess | undefined;
        gateMetadata: CrossRepoGateMetadata | undefined;
    }> {
        const configured = context.codeReviewConfig?.linkedRepositories;
        if (!configured?.length) {
            return { linkedRepoAccess: undefined, gateMetadata: undefined };
        }

        // Teams / Enterprise (and trial) only — free / CE self-hosted never
        // arm cross-repo context even if config still has links.
        const planAllowed = await this.isLinkedRepositoriesPlanAllowed(
            context.organizationAndTeamData,
        );
        if (!planAllowed) {
            this.logger.log({
                message:
                    'linkedRepositories configured but plan is not Teams/Enterprise — cross-repo context disabled',
                context: this.stageName,
                metadata: {
                    prNumber: context.pullRequest?.number,
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    configuredCount: configured.length,
                },
            });
            return {
                linkedRepoAccess: undefined,
                gateMetadata: {
                    activate: false,
                    reasons: ['plan_not_allowed'],
                    signalKinds: [],
                    signalCount: 0,
                },
            };
        }

        const gate = evaluateCrossRepoBoundaryGate(changedFiles);
        const gateMetadata: CrossRepoGateMetadata = {
            activate: gate.activate,
            reasons: gate.reasons,
            signalKinds: [...new Set(gate.signals.map((s) => s.kind))],
            signalCount: gate.signals.length,
        };

        if (!gate.activate) {
            this.logger.log({
                message:
                    'Cross-repo boundary gate OFF — linked repos configured but diff has no boundary surface; skipping linked-repo pass',
                context: this.stageName,
                metadata: {
                    prNumber: context.pullRequest?.number,
                    configuredCount: configured.length,
                    reasons: gate.reasons,
                },
            });
            return { linkedRepoAccess: undefined, gateMetadata };
        }

        this.logger.log({
            message: `Cross-repo boundary gate ON — ${gate.signals.length} signal(s): ${gate.reasons.join(', ')}`,
            context: this.stageName,
            metadata: {
                prNumber: context.pullRequest?.number,
                signalKinds: gateMetadata.signalKinds,
            },
        });

        const linkedRepoAccess = await this.buildLinkedRepoAccess(
            context,
            gateMetadata,
        );
        return { linkedRepoAccess, gateMetadata };
    }

    /**
     * Build lazy linked-repo access for cross-repo agent tools (#1576).
     * Returns undefined when the feature is off (no sandbox).
     * Caller must already have passed the boundary gate.
     *
     * Ref cascade (decision 1):
     *  1. PR-description override (`owner/repo#123` / URL / `@branch`)
     *  2. Config `ref` pin
     *  3. Open PR on matching head branch (prefer PR head)
     *  4. Head branch name
     *  5. Default branch (+ main/master fallbacks)
     *
     * Validation against the org's connected repos drops invalid entries
     * with warnings (never silently).
     */
    private async buildLinkedRepoAccess(
        context: CodeReviewPipelineContext,
        gateMetadata?: CrossRepoGateMetadata,
    ): Promise<LinkedRepoAccess | undefined> {
        const configured = context.codeReviewConfig?.linkedRepositories;
        if (!configured?.length) {
            return undefined;
        }
        if (!context.sandboxHandle?.run || !context.sandboxHandle?.repoDir) {
            this.logger.warn({
                message:
                    'linkedRepositories configured but no sandbox available — cross-repo context disabled for this review',
                context: this.stageName,
                metadata: {
                    prNumber: context.pullRequest?.number,
                    configuredCount: configured.length,
                },
            });
            return undefined;
        }

        try {
            const organizationAndTeamData = context.organizationAndTeamData;
            const platformType = context.platformType;
            const prHeadBranch =
                context.pullRequest?.head?.ref || context.branch;
            const prDescription = [
                context.pullRequest?.title,
                context.pullRequest?.body,
            ]
                .filter(Boolean)
                .join('\n\n');

            const connected =
                (await this.codeManagementService.getRepositories({
                    organizationAndTeamData,
                })) || [];

            const connectedMapped = connected.map((r) => ({
                id: String(r.id),
                name: r.name,
                full_name: r.full_name,
                default_branch: r.default_branch,
            }));

            // Pre-resolve description #N and open-PR-on-head-branch via API
            // so the cascade can prefer concrete heads over bare branch names.
            const descriptionOverrides =
                parsePrDescriptionOverrides(prDescription);
            const descriptionPrHeads = new Map<
                string,
                { prNumber: number; headRef: string; headSha?: string }
            >();
            const openPrOnHeadBranch = new Map<
                string,
                { prNumber: number; headRef: string; headSha?: string }
            >();

            // First pass: identify which configured repos are valid so we
            // only spend API calls on them.
            const firstPass = resolveLinkedRepositories({
                configured,
                connectedRepositories: connectedMapped,
                sandboxRepoDir: context.sandboxHandle.repoDir,
                prHeadBranch,
                prDescription,
                resolvePrHeadRefspec: (n) =>
                    prHeadRefspecForPlatform(String(platformType), n),
            });

            await Promise.all(
                firstPass.resolved.map(async (repo) => {
                    const override = findOverrideForRepo(
                        descriptionOverrides,
                        repo.fullName,
                    );

                    // Description #N / URL → resolve PR head via API
                    if (override?.kind === 'pr') {
                        try {
                            const pr =
                                await this.codeManagementService.getPullRequest(
                                    {
                                        organizationAndTeamData,
                                        repository: {
                                            id: repo.id,
                                            name: repo.name,
                                            fullName: repo.fullName,
                                        } as any,
                                        prNumber: override.prNumber,
                                    },
                                    platformType,
                                );
                            if (pr?.head?.ref || pr?.head?.sha) {
                                descriptionPrHeads.set(
                                    repo.fullName.toLowerCase(),
                                    {
                                        prNumber: override.prNumber,
                                        headRef: pr.head.ref || pr.head.sha!,
                                        headSha: pr.head.sha,
                                    },
                                );
                            }
                        } catch (err) {
                            this.logger.warn({
                                message: `Failed to resolve description PR #${override.prNumber} for linked repo ${repo.fullName}`,
                                context: this.stageName,
                                error: err,
                            });
                        }
                        return; // description override wins — skip open-PR lookup
                    }

                    if (!prHeadBranch) return;

                    try {
                        const openPrs =
                            await this.codeManagementService.getPullRequests(
                                {
                                    organizationAndTeamData,
                                    repository: {
                                        id: repo.id,
                                        name: repo.name,
                                    },
                                    filters: {
                                        state: PullRequestState.OPENED,
                                        branch: prHeadBranch,
                                    },
                                },
                                platformType,
                            );
                        const match = (openPrs || []).find((pr) => {
                            const headRef =
                                pr?.head?.ref || pr?.sourceRefName || '';
                            return (
                                headRef === prHeadBranch ||
                                headRef.endsWith(`/${prHeadBranch}`)
                            );
                        });
                        if (match) {
                            const prNumber =
                                match.number || match.pull_number;
                            if (prNumber) {
                                openPrOnHeadBranch.set(
                                    repo.fullName.toLowerCase(),
                                    {
                                        prNumber: Number(prNumber),
                                        headRef:
                                            match.head?.ref ||
                                            match.sourceRefName ||
                                            prHeadBranch,
                                        headSha: match.head?.sha,
                                    },
                                );
                            }
                        }
                    } catch (err) {
                        this.logger.warn({
                            message: `Failed to look up open PR on ${prHeadBranch} for linked repo ${repo.fullName}`,
                            context: this.stageName,
                            error: err,
                        });
                    }
                }),
            );

            const { resolved, warnings } = resolveLinkedRepositories({
                configured,
                connectedRepositories: connectedMapped,
                sandboxRepoDir: context.sandboxHandle.repoDir,
                prHeadBranch,
                prDescription,
                descriptionPrHeads,
                openPrOnHeadBranch,
                resolvePrHeadRefspec: (n) =>
                    prHeadRefspecForPlatform(String(platformType), n),
            });

            for (const w of warnings) {
                this.logger.warn({
                    message: w,
                    context: this.stageName,
                    metadata: {
                        prNumber: context.pullRequest?.number,
                        organizationId:
                            context.organizationAndTeamData?.organizationId,
                    },
                });
            }

            if (!resolved.length) {
                return undefined;
            }

            this.logger.log({
                message: `Linked repos ready for review: ${resolved
                    .map(
                        (r) =>
                            `${r.fullName}→${r.preferredRef}(${r.refCandidates[0]?.source || '?'})`,
                    )
                    .join(', ')}`,
                context: this.stageName,
                metadata: {
                    prNumber: context.pullRequest?.number,
                    descriptionOverrideCount: descriptionOverrides.size,
                    openPrMatchCount: openPrOnHeadBranch.size,
                },
            });

            return new LazyLinkedRepoAccess({
                sandbox: context.sandboxHandle,
                resolved,
                warnings,
                gate: gateMetadata,
                getCloneParams: async (repo) => {
                    try {
                        const params =
                            await this.codeManagementService.getCloneParams(
                                {
                                    repository: {
                                        id: repo.id,
                                        name: repo.name,
                                        fullName: repo.fullName,
                                        defaultBranch: repo.defaultBranch,
                                    },
                                    organizationAndTeamData,
                                },
                                platformType,
                            );
                        if (!params?.url) return null;
                        return {
                            url: params.url,
                            authToken: params.auth?.token || '',
                            authUsername: params.auth?.username,
                            platform: platformType,
                        };
                    } catch (err) {
                        this.logger.warn({
                            message: `Failed to resolve clone params for linked repo ${repo.fullName}`,
                            context: this.stageName,
                            error: err,
                        });
                        return null;
                    }
                },
            });
        } catch (err) {
            this.logger.warn({
                message:
                    'Failed to set up linkedRepositories — continuing without cross-repo context',
                context: this.stageName,
                error: err,
                metadata: {
                    prNumber: context.pullRequest?.number,
                },
            });
            return undefined;
        }
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
