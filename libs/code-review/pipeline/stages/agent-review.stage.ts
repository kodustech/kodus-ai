import * as crypto from 'crypto';

import { createLogger } from '@libs/core/log/logger';
import { jsonSchema, type EmbeddingModel } from 'ai';
import { tracedEmbed as embed } from '@libs/llm/llm-call';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { parseFinderSchema } from '@libs/code-review/infrastructure/agents/engine/parse-finder-schema';
import {
    buildSanitizerPrompt,
    SANITIZER_SCHEMA,
    sanitizerDiscardIndices,
} from '@libs/code-review/infrastructure/agents/engine/suggestion-sanitizer-prompt';
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
import { buildPlatformEmbedder } from '@libs/common/utils/document';
import {
    fullSuggestionTitle,
    MAX_TITLE_CHARS,
} from '@libs/common/utils/codeManagement/suggestion-title';
import { stripReviewScaffolding } from '@libs/code-review/infrastructure/agents/engine/strip-review-scaffolding';
import { resolveWritingGuidelines } from '@libs/common/utils/writing-guidelines';
import { formatAndShapeSuggestions } from '@libs/code-review/infrastructure/agents/engine/format-and-shape-suggestions';
import {
    dedupReviewWarnings,
    buildBadFixDowngradedWarning,
    buildCallGraphFailedWarning,
    buildConfigFileKeysIgnoredWarning,
    buildSandboxUnavailableWarning,
    crossRepoUnavailableWarning,
    type ReviewWarning,
} from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import {
    checkFix,
    type BadFixReason,
} from '@libs/code-review/infrastructure/agents/engine/is-usable-fix';
import { getModelName } from '@libs/llm/byok-to-vercel';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { buildKodyRuleLink } from '@libs/code-review/utils/build-kody-rule-link';
import { type LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';

import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import {
    CodeSuggestion,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { ReviewOrchestratorService } from '@libs/code-review/infrastructure/agents/review-orchestrator.service';
import { buildOrchestratorInput } from './build-orchestrator-input';
import type { KnowledgeCodeManagementPort } from '@libs/code-review/infrastructure/agents/knowledge/base-branch-reader';
import {
    resolveReviewKnowledge,
    type ReviewKnowledge,
} from '@libs/code-review/infrastructure/agents/knowledge/review-knowledge';
import { resolveAgentReviewSettings } from './agent-review-settings';
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
import {
    AgentProgressEvent,
    type CustomAgentCliRun,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    analyzerFindingsToSuggestions,
    isAnalyzerSuggestion,
} from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';
import { preferAnalyzerKeep } from '@libs/code-review/infrastructure/agents/engine/prefer-analyzer-keep';
import { normalizeSuggestionSeverity } from '@libs/code-review/infrastructure/agents/engine/normalize-severity';
import {
    capCustomAgentComments,
    collectSingleComments,
    customAgentSeverityVerdict,
    indexCustomAgents,
    isCustomAgentFinding,
    keepOwnFindingsApart,
    findingCitation,
    preferCustomAgentKeep,
    stripCustomAgentFixes,
    type CustomAgentsById,
} from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-presentation';
import { summarizeCustomAgentRuns } from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-summary';
import {
    customAgentSlug,
    ignoredFilesForCustomAgents,
} from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-scope';
import type { CustomAgentConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    isSameSpot,
    preferSpecificKeep,
} from '@libs/code-review/infrastructure/agents/engine/prefer-specific-keep';
import {
    bothFromAnalyzers,
    restatesAnalyzerFinding,
} from '@libs/code-review/infrastructure/agents/engine/restates-analyzer-finding';
import { survivesSeverityFilter } from '@libs/code-review/infrastructure/agents/engine/survives-severity-filter';
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
    collectRepoInstructions,
    shouldCollectRepoInstructions,
    type RepoInstructionsContext,
} from '@libs/code-review/infrastructure/agents/collaborators/repo-instructions';
import { AGENT_INSTRUCTION_FILE_DISCOVERY_PATTERNS } from '@libs/common/utils/kody-rules/file-patterns';
import {
    CodeReviewPipelineContext,
    resolvedModel,
    resolvedProvider,
    DedupTraceGroupSummary,
    DedupTraceSuggestionSummary,
    DedupTraceSummary,
} from '../context/code-review-pipeline.context';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import {
    LlmErrorCategory,
    classifyLLMError,
    getClassification,
    llmErrorLogLevel,
} from '@libs/llm/error-classifier';
import { hasManagedModelKey } from '@libs/llm/managed-slot';
import { LLM } from '@libs/llm/llm';
import { applyRevisionLinks } from '@libs/code-review/infrastructure/agents/engine/revision-link';
import { checkRepeats } from '@libs/code-review/infrastructure/agents/engine/repeat-check';
import {
    mergeKodyRuleFindings,
    otherLocationsToRender,
} from '@libs/code-review/infrastructure/agents/engine/kody-rules-merge';
import {
    MAX_REPEAT_CHECK_DECISIONS,
    type PrDecisionRecord,
} from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import { BuildPreviousReviewDecisionsUseCase } from '@libs/code-review/application/use-cases/previousReviewDecisions/build-previous-review-decisions.use-case';
import {
    isReducerEnabled,
    REDUCER_QUOTA,
    REDUCER_THRESHOLD,
    reduceFindings,
    type ReducerCandidate,
    type ReducerTrace,
} from '@libs/code-review/infrastructure/agents/engine/finding-reducer';
import {
    normalizeEnvelope,
    LLM_ENVELOPE_TAG,
} from '@libs/llm/structured-output-repair';

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
 * Which out-of-hunk findings survive the snap as file-anchored PR comments.
 *
 * Rules that declared they need more than the diff (issue #1826). Only such a
 * rule has earned the right to point at a line this PR did not change: "this
 * function is too long" is true of the whole function, most of which is
 * unchanged. Every other out-of-hunk finding is dropped — nothing else in the
 * pipeline can tell the two apart. Exported so the kody-rules eval scores what
 * this stage publishes, not the agent's raw output.
 */
export function fileAnchoredFindingPredicate(
    rules: Array<Partial<IKodyRule>>,
): (s: Partial<CodeSuggestion>) => boolean {
    const contextNeedingRuleUuids = new Set(
        rules
            .filter(
                (rule) =>
                    !!rule.uuid &&
                    !!rule.contextNeed?.need &&
                    rule.contextNeed.need !== 'diff-only',
            )
            .map((rule) => rule.uuid!),
    );
    return (s) =>
        s.label === 'kody_rules' &&
        (s.brokenKodyRulesIds ?? []).some((uuid) =>
            contextNeedingRuleUuids.has(uuid),
        );
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
        return normalizeSuggestionSeverity(severity);
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
        // Optional so specs that construct the stage manually still compile;
        // without it the repeat check uses the history loaded for the prompts.
        @Optional()
        private readonly buildPreviousReviewDecisionsUseCase?: BuildPreviousReviewDecisionsUseCase,
    ) {
        super();
    }

    /**
     * The repository's coding-agent instructions (CLAUDE.md, AGENTS.md,
     * .cursor/rules, ...) that govern the changed files, read from the PR's
     * target branch when the repository opted in (`repoInstructionsEnabled`). Never fails
     * the review: a git host error just means the review runs without them.
     */
    private async resolveRepoInstructions(
        context: CodeReviewPipelineContext,
        changedFiles: Array<{ filename: string }>,
        adaptiveProfile: { kind?: string; dropCallGraph?: boolean },
        prNumber: number,
    ): Promise<RepoInstructionsContext | undefined> {
        const enabled =
            context.codeReviewConfig?.repoInstructionsEnabled === true;
        const logMetadata = {
            organizationId: context.organizationAndTeamData?.organizationId,
            teamId: context.organizationAndTeamData?.teamId,
            repositoryId: context.repository?.id,
            prNumber,
        };

        if (
            !shouldCollectRepoInstructions(
                context.codeReviewConfig,
                adaptiveProfile,
            )
        ) {
            if (enabled) {
                this.logger.log({
                    message: `[repo-instructions] skipped for PR#${prNumber}: adaptive-fit profile ${adaptiveProfile.kind} drops optional context`,
                    context: this.stageName,
                    metadata: { ...logMetadata, profile: adaptiveProfile.kind },
                });
            }
            return undefined;
        }

        // Deep mode dispatches only the category agents, which never render
        // the instructions block.
        if (context.codeReviewConfig?.reviewMode === 'deep') {
            this.logger.log({
                message: `[repo-instructions] skipped for PR#${prNumber}: deep review mode does not read them`,
                context: this.stageName,
                metadata: logMetadata,
            });
            return undefined;
        }

        // The generalist, the only agent that reads them, runs only when at
        // least one of these categories is on.
        const options = context.codeReviewConfig?.reviewOptions;
        if (
            options?.bug === false &&
            options?.security === false &&
            options?.performance === false
        ) {
            this.logger.warn({
                message: `[repo-instructions] skipped for PR#${prNumber}: bug, security and performance are all off, so no agent reads them`,
                context: this.stageName,
                metadata: logMetadata,
            });
            return undefined;
        }

        const organizationAndTeamData = context.organizationAndTeamData;
        const repository = {
            id: String(context.repository?.id ?? ''),
            name: context.repository?.name,
        };
        // The target branch, never the head: what a PR is checked against is
        // what the team merged, not text the PR itself adds or edits.
        const ref = context.pullRequest?.base?.ref;
        if (!ref) {
            this.logger.warn({
                message: `[repo-instructions] skipped for PR#${prNumber}: target branch unknown`,
                context: this.stageName,
                metadata: logMetadata,
            });
            return undefined;
        }
        const startedAt = Date.now();

        const result = await collectRepoInstructions({
            changedFiles: changedFiles.map((f) => f.filename),
            listFiles: async () => {
                const files =
                    (await this.codeManagementService.getRepositoryAllFiles({
                        organizationAndTeamData,
                        repository,
                        filters: {
                            branch: ref,
                            filePatterns: [
                                ...AGENT_INSTRUCTION_FILE_DISCOVERY_PATTERNS,
                            ],
                        },
                    })) ?? [];
                return files.map((f: { path: string }) => f.path);
            },
            readFile: async (path) => {
                const response =
                    await this.codeManagementService.getRepositoryContentFile({
                        organizationAndTeamData,
                        repository,
                        file: { filename: path },
                        pullRequest: { head: { ref }, base: { ref } },
                    });
                // Forgejo returns the file flat and already decoded; the
                // other providers wrap it in `data`.
                const file = response?.data ?? response;
                const raw = file?.content;
                if (typeof raw !== 'string' || !raw) return null;
                return file?.encoding === 'base64'
                    ? Buffer.from(raw, 'base64').toString('utf-8')
                    : raw;
            },
        });

        const bytes = result.files.reduce(
            (sum, f) => sum + Buffer.byteLength(f.content),
            0,
        );
        const unreadable = result.unreadable ?? [];
        this.logger[result.error || unreadable.length ? 'warn' : 'log']({
            message: `[repo-instructions] PR#${prNumber}: indexed=${result.indexedCount} listed=${result.files.length} dropped=${result.dropped.length} unreadable=${unreadable.length} bytes=${bytes} truncated=${result.truncated}${result.error ? ` error=${result.error}` : ''}`,
            context: this.stageName,
            metadata: {
                ...logMetadata,
                ref,
                durationMs: Date.now() - startedAt,
                indexed: result.indexedCount,
                listed: result.files.map((f) => f.path),
                dropped: result.dropped,
                unreadable,
                bytes,
                truncated: result.truncated,
                error: result.error,
            },
        });

        return result.files.length ? result : undefined;
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
     * The custom agents this review may dispatch (#2172): the enabled ones,
     * or the one `@kody -v` names even when it is off.
     */
    async resolveCustomAgents(
        context: CodeReviewPipelineContext,
    ): Promise<CustomAgentConfig[]> {
        const configured = context.codeReviewConfig?.customAgents ?? [];
        const wanted = context.onlyCustomAgent
            ? configured
            : configured.filter((agent) => agent?.enabled);
        if (!wanted.length) {
            return [];
        }
        return wanted;
    }

    /**
     * One line per review with what each custom agent did (#2172): ran or
     * why not, findings kept, merged into another comment by the dedup, and
     * what the checks and filters set aside, by reason. Counts, ids and the
     * checks' reasons, never a finding's text. Disabled agents are listed so
     * "my agent did not comment" is answered from the logs.
     */
    private logCustomAgentOutcome(
        context: CodeReviewPipelineContext,
        runs: ReturnType<typeof summarizeCustomAgentRuns>,
        discarded: Array<Partial<CodeSuggestion>>,
        mergedInDedup: Array<Partial<CodeSuggestion>>,
    ): void {
        const configured = context.codeReviewConfig?.customAgents ?? [];
        if (!configured.length) return;
        const disabled = context.onlyCustomAgent
            ? []
            : configured.filter((a) => !a?.enabled).map((a) => a.id);
        this.logger.log({
            message: `[AGENT] Custom agents outcome for PR#${context.pullRequest?.number}`,
            context: this.stageName,
            metadata: {
                organizationId: context.organizationAndTeamData?.organizationId,
                teamId: context.organizationAndTeamData?.teamId,
                repositoryId: context.repository?.id,
                repositoryName: context.repository?.name,
                prNumber: context.pullRequest?.number,
                onlyCustomAgent: context.onlyCustomAgent,
                disabled,
                agents: runs.map((run) => ({
                    id: run.id,
                    slug: run.slug,
                    status: run.status,
                    kept: run.posted,
                    droppedByChecks: run.droppedByVerify,
                    mergedInDedup: mergedInDedup.filter(
                        (s) => s.customAgent?.id === run.id,
                    ).length,
                    // Where and why the checks refuted each finding; the
                    // finding's own text stays out.
                    checkDrops: discarded
                        .filter(
                            (s) =>
                                s.customAgent?.id === run.id &&
                                CHECK_DROPS.has(s.priorityStatus),
                        )
                        .map((s) => ({
                            at: `${s.relevantFile}:${s.relevantLinesStart}`,
                            reason:
                                s.priorityStatus ===
                                PriorityStatus.DISCARDED_BY_VERIFY_ERROR
                                    ? 'the check could not run'
                                    : (s.discardReason ?? 'refuted').slice(
                                          0,
                                          300,
                                      ),
                        })),
                    discarded: discarded
                        .filter((s) => s.customAgent?.id === run.id)
                        .reduce<Record<string, number>>((counts, s) => {
                            const why = String(s.priorityStatus ?? 'unknown');
                            counts[why] = (counts[why] ?? 0) + 1;
                            return counts;
                        }, {}),
                })),
            },
        });
    }

    /**
     * Skills and docs linked to the main review and to each custom agent,
     * read from the PR's target branch (#2172). See resolveReviewKnowledge.
     */
    private async resolveReviewKnowledge(
        context: CodeReviewPipelineContext,
        customAgents: CustomAgentConfig[],
        changedFiles: Array<{ filename?: string }>,
    ): Promise<ReviewKnowledge> {
        return resolveReviewKnowledge({
            items: context.codeReviewConfig?.knowledge,
            customAgents,
            changedFiles,
            baseBranch:
                context.pullRequest?.base?.ref ||
                context.sandboxHandle?.baseBranch ||
                context.repository?.defaultBranch,
            sandbox: context.sandboxHandle,
            codeManagement: this
                .codeManagementService as unknown as KnowledgeCodeManagementPort,
            organizationAndTeamData: context.organizationAndTeamData,
            repository: context.repository,
            logContext: this.stageName,
            prNumber: context.pullRequest?.number,
        });
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
        const changedFiles = context.changedFiles ?? [];
        // The ignored files a custom agent names explicitly (#2172), with the
        // content and line numbers FetchChangedFilesStage gave them; they are
        // a review of their own when every changed file is ignored.
        const ignoredChangedFiles = ignoredFilesForCustomAgents(
            context,
            context.ignoredFileChanges,
        );

        if (!changedFiles.length && !ignoredChangedFiles.length) {
            return context;
        }
        // What each custom agent's CLIs reported, cited by its findings.
        const cliRuns: CustomAgentCliRun[] = [];

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

        // Categories and the adaptive-fit profile for the resolved model
        // (agent-review-settings.ts, also run by the finder eval).
        const {
            reviewOptions,
            effectiveModelName,
            effectiveContextWindow,
            adaptiveProfile,
        } = resolveAgentReviewSettings(context.codeReviewConfig);
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
        // customAgents/knowledge written in kodus-config.yml were dropped by
        // the file loader; the review still runs, and says so on the PR.
        const configFileWarning = buildConfigFileKeysIgnoredWarning(
            context.codeReviewConfig?.kodusConfigFileDroppedKeys,
        );
        if (configFileWarning) stageWarnings.push(configFileWarning);

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
            // Build progress callback for real-time agent traces in PR timeline.
            // `context.correlationId` is a `corr_<random>_<timestamp>` tracing
            // id (id-generator.ts), never a real UUID — it must NOT be used
            // here as a fallback. `writeAgentTrace` already falls back to a
            // {pullRequestNumber, repositoryId} filter when this is undefined
            // (prod incident, 2026-09-14: "invalid input syntax for type
            // uuid" writing automation_execution whenever lastExecution.uuid
            // was absent and the old `||` fallback poisoned the query).
            const executionUuid = context.pipelineMetadata?.lastExecution?.uuid;
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
                new Map(
                    (context.codeReviewConfig?.customAgents ?? []).map(
                        (agent) => [customAgentSlug(agent.name), agent.name],
                    ),
                ),
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

            // The null sandbox (no provider, or no clone params) carries
            // remoteCommands that only throw, so the checkout is told by its
            // type, as null-sandbox.service.ts asks callers to.
            const hasCheckout =
                !!context.sandboxHandle?.remoteCommands &&
                context.sandboxHandle.type !== 'null';
            if (!hasCheckout && !context.sandboxSuperseded) {
                stageWarnings.push(
                    buildSandboxUnavailableWarning({
                        modelName: effectiveModelName || 'unknown',
                    }),
                );
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
                    // Without a checkout the graph cannot build; that loss is
                    // already SANDBOX_UNAVAILABLE.
                    if (hasCheckout) {
                        stageWarnings.push(
                            buildCallGraphFailedWarning({
                                modelName: effectiveModelName || 'unknown',
                            }),
                        );
                    }
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
            const crossRepoLost = crossRepoUnavailableWarning({
                configured:
                    context.codeReviewConfig?.linkedRepositories?.length ?? 0,
                gateActive: !!gateMetadata?.activate,
                hasAccess: !!linkedRepoAccess,
                hasCheckout,
                modelName: effectiveModelName || 'unknown',
            });
            if (crossRepoLost) stageWarnings.push(crossRepoLost);

            const repoInstructions = await this.resolveRepoInstructions(
                context,
                changedFiles,
                adaptiveProfile,
                prNumber,
            );

            const customAgents = await this.resolveCustomAgents(context);
            const customAgentsById: CustomAgentsById =
                indexCustomAgents(customAgents);
            const reviewKnowledge = await this.resolveReviewKnowledge(
                context,
                customAgents,
                changedFiles,
            );
            stageWarnings.push(...reviewKnowledge.warnings);
            const result = await this.reviewOrchestrator.execute({
                ...buildOrchestratorInput(context, {
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
                    repoInstructions,
                }),
                customAgents,
                onlyCustomAgent: context.onlyCustomAgent,
                ignoredChangedFiles,
                knowledgeByTarget: reviewKnowledge.byTarget,
                knowledgeReader: reviewKnowledge.reader,
                customAgentTooling: {
                    sandbox: context.sandboxHandle,
                    installedClis: context.customAgentClis?.byAgentId,
                    onCliRun: (run) => cliRuns.push(run),
                },
            });

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
                // A custom agent is auxiliary, like kody-rules: its failure
                // leaves the review partial, not failed.
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
                if (!CRITICAL_AGENTS.has(cut.agentName) && !cut.customAgent) {
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
                            cut.finishReason === 'truncated'
                                ? `Agent "${cut.agentName}" had its turn truncated by the model provider after ${cut.durationMs}ms — the review did not complete`
                                : cut.finishReason === 'no-result'
                                  ? `Agent "${cut.agentName}" ended after ${cut.durationMs}ms without submitting a result — the review did not complete`
                                  : `Agent "${cut.agentName}" ran out of steps after ${cut.durationMs}ms — the review did not complete`,
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

            // An agent whose verify call failed left findings nobody judged.
            // They were not published, so the review did not check everything
            // it found: 'partial', same as a cut-short agent (#2171).
            for (const gap of result.unverified || []) {
                if (!CRITICAL_AGENTS.has(gap.agentName) && !gap.customAgent) {
                    continue;
                }

                context = this.updateContext(context, (draft) => {
                    if (!draft.errors) {
                        draft.errors = [];
                    }
                    draft.errors.push({
                        pipelineId: context.pipelineMetadata?.pipelineId,
                        stage: this.stageName,
                        substage: `agent:${gap.agentName}`,
                        error: new Error(
                            `Agent "${gap.agentName}" could not verify ${gap.unverifiedCount} finding(s) — they were not posted and the review did not complete`,
                        ),
                        severity: 'partial',
                        metadata: {
                            agentName: gap.agentName,
                            category: gap.category,
                            unverifiedCount: gap.unverifiedCount,
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
                // Classify against the provider that ANSWERED, not the one
                // resolved before the run. The friendly sentence names the
                // provider inline ("the key (openai) appears invalid"), so
                // classifying with the pre-run slot after a cascade puts one
                // provider in the prose and another in the facts line — the
                // same never-co-occurred pair, split across two fields.
                // A classification already attached by byok-model-wrapper is
                // anchored to the attempt that raised it, so it is preferred.
                const classifyFailure = (f: (typeof failures)[number]) =>
                    getClassification(f.error) ??
                    classifyLLMError(
                        f.error,
                        resolvedProvider(context, f.error),
                    );
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
                        provider:
                            classification.provider ??
                            resolvedProvider(context, chosen.error),
                        friendlyMessage: classification.friendlyMessage,
                        httpStatus: classification.httpStatus,
                        providerMessage: classification.providerMessage,
                        model: resolvedModel(context, chosen.error),
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
                ...(context.customAgentClis?.warnings ?? []),
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
                            deliveryStatus: DeliveryStatus.NOT_SENT,
                        });
                    }
                }
                if (agentResult.discardedByVerify?.length) {
                    for (const s of agentResult.discardedByVerify) {
                        allDiscarded.push({
                            ...s,
                            priorityStatus:
                                PriorityStatus.DISCARDED_BY_SAFEGUARD,
                            deliveryStatus: DeliveryStatus.NOT_SENT,
                        });
                    }
                }
                if (agentResult.discardedByVerifyError?.length) {
                    for (const s of agentResult.discardedByVerifyError) {
                        allDiscarded.push({
                            ...s,
                            priorityStatus:
                                PriorityStatus.DISCARDED_BY_VERIFY_ERROR,
                            deliveryStatus: DeliveryStatus.NOT_SENT,
                        });
                    }
                }
            }

            // Parse schema (#1821), check half: a finder suggestion without the
            // five lean fields is discarded here, before anchoring, so every
            // suggestion anchored has a file and lines. The fields it does not
            // carry are removed later (leanFinderSuggestions), after the repeat
            // check, which matches an earlier comment by its existingCode.
            const finderSuggestions = result.suggestions.filter(
                (s) => s.label !== 'kody_rules',
            );
            const parsed = parseFinderSchema(
                finderSuggestions as Array<Record<string, unknown>>,
            );
            const parseDiscarded = new Set(
                parsed.discarded.map((d) => d.index),
            );
            if (parsed.discarded.length > 0) {
                this.logger.warn({
                    message: `[PARSE-SCHEMA] PR#${prNumber}: discarded ${parsed.discarded.length} finder suggestions missing lean fields`,
                    context: this.stageName,
                    metadata: {
                        organizationId:
                            context.organizationAndTeamData?.organizationId,
                        teamId: context.organizationAndTeamData?.teamId,
                        prNumber,
                        discarded: parsed.discarded,
                    },
                });
            }
            // Sanitizer (#1821): drops the finder suggestions that report no
            // problem ("no sensitive data exposed") before anything else reads them.
            const sanitized = await this.sanitizeSuggestions(
                finderSuggestions.filter((_, i) => !parseDiscarded.has(i)),
                prNumber,
                context.codeReviewConfig?.resolvedModelSlot,
                telemetryMeta,
            );
            for (const s of sanitized.discarded) {
                allDiscarded.push({
                    ...s,
                    priorityStatus: PriorityStatus.DISCARDED_BY_SAFEGUARD,
                    deliveryStatus: DeliveryStatus.NOT_SENT,
                });
            }
            const anchoringInput: Partial<CodeSuggestion>[] = [
                ...sanitized.kept,
                ...result.suggestions.filter((s) => s.label === 'kody_rules'),
            ];

            const changedFilesByName = new Map(
                changedFiles.map((f) => [f.filename, f]),
            );
            // A custom agent's findings on an ignored file it names are held
            // to that file's hunks like any other.
            const validatedSuggestions = this.anchorSuggestionsToDiff(
                anchoringInput,
                [...changedFiles, ...ignoredChangedFiles],
                context.codeReviewConfig?.kodyRules ?? [],
                allDiscarded,
            );

            // Verify/Discover removed — was hurting recall across all models.
            // Benchmark showed F1 drops of -5.7pp to -18.3pp with verify enabled.
            const reflectedSuggestions = validatedSuggestions;

            const {
                kodyRulesById,
                kodyRulesWithSeverity,
                severityNormalizedNonRules,
            } = this.normalizeSuggestionSeverities(
                reflectedSuggestions,
                context.codeReviewConfig?.kodyRules ?? [],
            );

            // Rule-pack findings join the non-rule stream so they dedupe
            // against the model's findings instead of arriving as a parallel
            // set of comments on the same lines. Their severity is already on
            // the v2 scale, so they skip normalizeSeverity.
            const analyzerSuggestions = analyzerFindingsToSuggestions(
                context.analyzerFindings ?? [],
            );

            // #2097: what an earlier comment on this PR already raised is not
            // posted again. Runs on each occurrence, before the dedups below
            // fold several occurrences into one representative: judged after
            // them, a group was kept or dropped whole by whichever occurrence
            // had the longest text. Also before the severity and formatter
            // passes, so a repeat costs no further model call.
            const repeatCheck = await this.dropRepeats(
                context,
                [
                    ...severityNormalizedNonRules,
                    ...analyzerSuggestions,
                    ...kodyRulesWithSeverity,
                ],
                kodyRulesById,
                telemetryMeta,
            );
            for (const s of repeatCheck.repeats) {
                allDiscarded.push({
                    ...s,
                    priorityStatus: PriorityStatus.DISCARDED_BY_REPEAT,
                    deliveryStatus: DeliveryStatus.NOT_SENT,
                });
            }
            // Parse schema (#1821), strip half: from here on a finder suggestion
            // carries only the lean fields (and its normalized severity, which
            // the severity steps after the dedup read); code snippets come back
            // at enrichment. Kody Rules, analyzer and custom agent findings
            // keep theirs: the custom agent stages after this read its fields.
            let severityNormalized: Partial<CodeSuggestion>[] =
                repeatCheck.kept.map((s) => {
                    if (
                        s.label === 'kody_rules' ||
                        isAnalyzerSuggestion(s) ||
                        isCustomAgentFinding(s)
                    ) {
                        return s;
                    }
                    const lean = parseFinderSchema([
                        s as Record<string, unknown>,
                    ]).suggestions[0] as unknown as
                        | Partial<CodeSuggestion>
                        | undefined;
                    return lean ? { ...lean, severity: s.severity } : s;
                });

            // A custom agent's own severity floor and comment limit apply
            // whatever the team's filter is (#2172), and also before dedup:
            // a finding dropped after it had absorbed a native one would take
            // the native comment with it.
            if (customAgentsById.size > 0) {
                const belowAgentFloor = severityNormalized.filter(
                    (s) =>
                        customAgentSeverityVerdict(s, customAgentsById) ===
                        false,
                );
                if (belowAgentFloor.length) {
                    severityNormalized = severityNormalized.filter(
                        (s) => !belowAgentFloor.includes(s),
                    );
                    for (const s of belowAgentFloor) {
                        allDiscarded.push({
                            ...s,
                            priorityStatus:
                                PriorityStatus.DISCARDED_BY_SEVERITY,
                            deliveryStatus: DeliveryStatus.NOT_SENT,
                        });
                    }
                }
                const capped = capCustomAgentComments(
                    severityNormalized,
                    customAgentsById,
                );
                severityNormalized = capped.kept;
                allDiscarded.push(...capped.overflow);
            }

            const dedup = await this.dedupSuggestionStreams(
                severityNormalized,
                prNumber,
                context,
                telemetryMeta,
            );
            let deduped = dedup.deduped;
            const dedupTrace = dedup.dedupTrace;
            // A custom agent's findings the dedup merged into another
            // comment, which posts in their place: neither posted as the
            // agent's nor dropped, so the outcome log counts them apart.
            const keptByDedup = new Set(deduped);
            const mergedInDedup = severityNormalized.filter(
                (s) => isCustomAgentFinding(s) && !keptByDedup.has(s),
            );

            // NOTE: Kody Rule link enrichment happens AFTER the content
            // formatter (see block further below). Doing it before would
            // let the formatter LLM strip or reword the link when it
            // collapses WHAT/WHY/HOW into natural prose.

            deduped = await this.reclassifyAndFilterSeverity(
                deduped,
                context,
                allDiscarded,
                customAgentsById,
            );

            // The agent's fix policy (its floor and limit applied before dedup).
            if (customAgentsById.size > 0) {
                stripCustomAgentFixes(deduped, customAgentsById);
            }

            // The formatter shortens the body for people reading the PR; the
            // whole explanation is kept for the agent prompt and agent surfaces.
            for (const s of deduped) {
                s.fullExplanation = stripReviewScaffolding(
                    s.suggestionContent || '',
                );
            }

            // Every finding renders under a title: the model's summary, or the
            // first sentence of the body when the model left it out. Resolved
            // before formatting and shaping, so neither repeats it as the
            // body's opening. Not bounded yet: the formatter rewrites a title
            // over the ceiling, and formatAndShapeSuggestions bounds the rest.
            const titleCounts = {
                fromSummary: 0,
                fromBody: 0,
                overCeiling: 0,
                empty: 0,
            };
            for (const s of deduped) {
                const hadSummary = !!s.oneSentenceSummary?.trim();
                s.oneSentenceSummary = fullSuggestionTitle({
                    summary: s.oneSentenceSummary,
                    body: (
                        s.fullExplanation ||
                        s.suggestionContent ||
                        ''
                    ).replace(/```[\s\S]*?```/g, ' '),
                });
                if (!s.oneSentenceSummary) titleCounts.empty++;
                else if (hadSummary) titleCounts.fromSummary++;
                else titleCounts.fromBody++;
                if (s.oneSentenceSummary.length > MAX_TITLE_CHARS) {
                    titleCounts.overCeiling++;
                }
            }
            this.logger.log({
                message: `[AGENT] Titled ${deduped.length} suggestions (from summary ${titleCounts.fromSummary}, from body ${titleCounts.fromBody}, over the ceiling ${titleCounts.overCeiling}, empty ${titleCounts.empty})`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest?.number,
                    ...titleCounts,
                },
            });

            const savedGenerationMain =
                context.codeReviewConfig?.v2PromptOverrides?.generation?.main;
            const writingGuidelines =
                resolveWritingGuidelines(savedGenerationMain);

            // Clean up suggestion text: remove WHAT/WHY/HOW labels, merge into
            // natural prose, then give each comment the shape it needs
            // (format-and-shape-suggestions.ts, also run by evals/format).
            const { formatted, formatTargets, formatError, shapeCounts } =
                await formatAndShapeSuggestions(deduped, {
                    writingGuidelines,
                    byokConfig: context.codeReviewConfig?.byokConfig,
                    languageResultPrompt:
                        context.codeReviewConfig?.languageResultPrompt,
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    customAgentsById,
                });
            const formatLogMetadata = {
                organizationAndTeamData: context.organizationAndTeamData,
                prNumber: context.pullRequest?.number,
                formatted,
                formatTargets,
            };
            if (formatError !== undefined) {
                this.logger.warn({
                    message: `[AGENT] Content formatting failed, keeping original text: ${formatError instanceof Error ? formatError.message : String(formatError)}`,
                    context: this.stageName,
                    metadata: formatLogMetadata,
                });
            } else {
                this.logger.log({
                    message: `[AGENT] Formatted ${formatted}/${formatTargets} suggestion contents`,
                    context: this.stageName,
                    metadata: formatLogMetadata,
                });
            }
            this.logger.log({
                message: `[AGENT] Shaped ${shapeCounts.shaped} suggestion bodies (fences removed ${shapeCounts.removedFences}, title repeat dropped ${shapeCounts.droppedTitleRepeat}, capped ${shapeCounts.capped}, titles rewritten ${shapeCounts.titleRewritten}, titles cut ${shapeCounts.titleCut})`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest?.number,
                    ...shapeCounts,
                    writingGuidelines: writingGuidelines.isCustom
                        ? 'custom'
                        : savedGenerationMain
                          ? 'saved-default'
                          : 'default',
                },
            });

            // Publication gate (issue #1833): four weeks of production
            // thumbs-down showed 38% had no usable fix — empty, identical to
            // existingCode, or syntactically truncated. A correct diagnosis
            // with a broken "fix" reads as OUR mistake, not a miss. (Prose-
            // only detection was tried and removed — see is-usable-fix.ts's
            // header: no regex reliably tells English apart from code.)
            // Rather than dropping the whole finding, strip the unusable
            // improvedCode and publish as a plain comment: the renderer
            // already omits the code block when improvedCode is empty
            // (github.service.ts's `codeBlock = improvedCode ? ... : ''`),
            // the same path PR-level Kody Rule findings with no existingCode
            // already use. Runs AFTER the content formatter (which never
            // touches improvedCode, only suggestionContent/llmPrompt) and
            // BEFORE the Kody Rule link enrichment.
            {
                const badFixCounts: Partial<Record<BadFixReason, number>> = {};
                for (const s of deduped) {
                    const reason = checkFix(
                        s.existingCode,
                        s.improvedCode,
                        s.language,
                    );
                    if (!reason) {
                        continue;
                    }
                    badFixCounts[reason] = (badFixCounts[reason] ?? 0) + 1;
                    s.improvedCode = '';
                }
                const totalBadFix = Object.values(badFixCounts).reduce(
                    (sum: number, n) => sum + (n ?? 0),
                    0,
                );
                if (totalBadFix > 0) {
                    this.logger.log({
                        message: `[AGENT] Downgraded ${totalBadFix} suggestion(s) with unusable improvedCode to plain comments`,
                        context: this.stageName,
                        metadata: {
                            prNumber,
                            organizationId:
                                context.organizationAndTeamData?.organizationId,
                            ...badFixCounts,
                        },
                    });
                    context = this.updateContext(context, (draft) => {
                        draft.reviewWarnings = dedupReviewWarnings([
                            ...(draft.reviewWarnings ?? []),
                            buildBadFixDowngradedWarning({
                                count: totalBadFix,
                                modelName: getModelName(
                                    context.codeReviewConfig?.byokConfig,
                                ),
                                agentName: 'agent-review',
                            }),
                        ]);
                    });
                }
            }

            // The CLI output that names a custom agent finding's file and the
            // team rule it applies, after formatting so the rewrite cannot
            // paraphrase or drop them (#2172).
            for (const s of deduped) {
                const citation = findingCitation(s, cliRuns);
                if (!citation) continue;
                s.suggestionContent = `${s.suggestionContent || ''}${citation}`;
                s.fullExplanation = `${s.fullExplanation || ''}${citation}`;
            }

            // Render merged locations after formatting so rewrites cannot drop them.
            for (const s of deduped) {
                const otherLocations = otherLocationsToRender(s);
                if (!otherLocations?.length) {
                    continue;
                }
                const locationsList = otherLocations
                    .map((loc) => `- \`${loc}\``)
                    .join('\n');
                const otherLocationsSection = `\n\n**Also found in:**\n${locationsList}`;
                s.suggestionContent = `${s.suggestionContent}${otherLocationsSection}`;
                // llmPrompt is built from fullExplanation below; without the
                // list an agent working from the prompt fixes only the kept
                // location.
                s.fullExplanation = `${s.fullExplanation || ''}${otherLocationsSection}`;
                this.logger.log({
                    message: '[AGENT] Rendered merged finding locations',
                    context: this.stageName,
                    metadata: {
                        prNumber,
                        organizationId:
                            context.organizationAndTeamData?.organizationId,
                        locationCount: otherLocations.length,
                        isKodyRule: s.label === 'kody_rules',
                    },
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

                // The same link goes in the body and in the full explanation,
                // which the prompt and the agent surfaces read. Each text links
                // the rule title where it names it, or gains a link line.
                const withRuleLink = (text: string): string => {
                    if (text.includes(ruleLink)) return text;
                    return text.includes(rule.title)
                        ? text.replace(rule.title, markdownLink)
                        : `${text}\n\nKody rule violation: ${markdownLink}`;
                };
                s.suggestionContent = withRuleLink(s.suggestionContent || '');
                if (s.fullExplanation) {
                    s.fullExplanation = withRuleLink(s.fullExplanation);
                }
            }

            // llmPrompt feeds the "Prompt for LLM" block, the consolidated
            // @agentPrompt and validate-suggestions' fixer instruction, so it
            // carries the title and the whole explanation, not the short body.
            for (const s of deduped) {
                if (s.fullExplanation) {
                    s.llmPrompt = s.oneSentenceSummary
                        ? `${s.oneSentenceSummary}\n\n${s.fullExplanation}`
                        : s.fullExplanation;
                }
            }

            // #2039/#2020: a finding that revises, reverses or exists because
            // of an earlier Kody suggestion on this PR says so, in a line the
            // formatter never sees (same reason as the rule link above).
            applyRevisionLinks(deduped, repeatCheck.history);

            // Separate PR-level kody rules (no anchor) from file-level suggestions.
            // PR-level suggestions go to validSuggestionsByPR → CreatePrLevelCommentsStage.
            // A file-anchored finding takes the same route: it is about the
            // file, so there is no line in the diff to hang it on.
            // A missing relevantFile alone already means it can't be anchored
            // to a diff position — a lone relevantLinesStart with no
            // relevantFile used to fall through to file-level grouping keyed
            // on '', which never matches a real changed file and silently
            // dropped the finding as DISCARDED_BY_CODE_DIFF.
            //
            // A relevantFile that names a file THIS PR TOUCHES but carries no
            // line also can't be anchored: calculateCommentStartLine (in
            // comment-builder.utils.ts) returns undefined for a missing
            // relevantLinesStart, and create-file-comments.stage.ts posts the
            // comment anyway with start_line/line both undefined — a broken
            // inline comment, not a discard. Route it PR-level instead, same
            // as the no-file case.
            //
            // A relevantFile naming a file OUTSIDE this PR must NOT take this
            // branch even with no line citation: it still needs to go through
            // the file-level branch below so the `changedFiles` guard discards
            // it (KRC-20) instead of leaking out as an unanchored PR-level
            // comment. `changedFilesByName` (built above for the diff-snap
            // step) tells the two cases apart.
            const isPrLevelSuggestion = (s: Partial<CodeSuggestion>): boolean =>
                s.label === 'kody_rules' &&
                (!s.relevantFile ||
                    s.fileAnchored === true ||
                    (!s.relevantLinesStart &&
                        changedFilesByName.has(s.relevantFile)));
            // Agents set to `single-comment` publish one PR-level comment
            // gathering their findings instead of inline comments (#2172).
            const singleComments = collectSingleComments(
                deduped,
                customAgentsById,
            );
            deduped = singleComments.inline;
            const customAgentSummaries = summarizeCustomAgentRuns(
                result.customAgentRuns,
                [...deduped, ...singleComments.grouped],
                {
                    agents: context.codeReviewConfig?.customAgents ?? [],
                    ignoredFiles: context.ignoredFiles ?? [],
                    // Deleted files sit in ignoredFiles too; the ignored
                    // changes hold only the files the ignore paths matched.
                    removedFiles: (context.ignoredFiles ?? []).filter(
                        (f) =>
                            !(context.ignoredFileChanges ?? []).some(
                                (c) => c.filename === f,
                            ),
                    ),
                },
            );
            this.logCustomAgentOutcome(
                context,
                customAgentSummaries,
                allDiscarded,
                mergedInDedup,
            );
            const prLevelSuggestions = deduped.filter(isPrLevelSuggestion);
            const fileLevelSuggestions = deduped.filter(
                (s) => !isPrLevelSuggestion(s),
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

                // Keyed once rather than scanned per file: this loop runs over
                // every affected file and both lists can be large on a wide PR.
                const changedByName = new Map(
                    changedFiles.map((f) => [f.filename, f]),
                );
                const ignoredByName = new Map(
                    (context.ignoredFileChanges ?? []).map((f) => [
                        f.filename,
                        f,
                    ]),
                );

                draft.fileAnalysisResults = [];
                for (const filename of allAffectedFiles) {
                    const suggestions = byFile.get(filename) ?? [];
                    // Analyzer findings legitimately land on files the review
                    // itself ignores — a lockfile is the common case, since
                    // ignorePaths hides it from the reviewer while the
                    // dependency scan still has to report what it introduces.
                    // Resolving only against changedFiles discarded those.
                    const file =
                        changedByName.get(filename) ??
                        ignoredByName.get(filename);
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
                                deliveryStatus: DeliveryStatus.NOT_SENT,
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
                            id: crypto.randomUUID(),
                            // Any finding that named a file has to say WHERE,
                            // since a PR-level comment carries no anchor of
                            // its own — true whether it's fileAnchored
                            // (explicitly out-of-hunk) or just missing a
                            // line. Cite a line only when one is real
                            // (`!s.relevantLinesStart`, same falsy check
                            // `isPrLevelSuggestion` uses above): fabricating
                            // `:1` for a finding that has no line — the
                            // empty/unparseable-patch case — would point at
                            // a line that need not exist in the diff at all.
                            suggestionContent: s.relevantFile
                                ? s.relevantLinesStart
                                    ? `\`${s.relevantFile}:${s.relevantLinesStart}\` — ${s.suggestionContent || ''}`
                                    : `\`${s.relevantFile}\` — ${s.suggestionContent || ''}`
                                : s.suggestionContent || '',
                            oneSentenceSummary: s.oneSentenceSummary || '',
                            fullExplanation: s.relevantFile
                                ? s.relevantLinesStart
                                    ? `\`${s.relevantFile}:${s.relevantLinesStart}\` — ${s.fullExplanation || s.suggestionContent || ''}`
                                    : `\`${s.relevantFile}\` — ${s.fullExplanation || s.suggestionContent || ''}`
                                : s.fullExplanation,
                            label: (s.label as any) || 'kody_rules',
                            severity: this.normalizeSeverity(
                                s.severity,
                            ) as SeverityLevel,
                            brokenKodyRulesIds: s.brokenKodyRulesIds,
                            deliveryStatus: DeliveryStatus.NOT_SENT,
                        })),
                    );
                }

                if (singleComments.prLevel.length > 0) {
                    if (!draft.validSuggestionsByPR) {
                        draft.validSuggestionsByPR = [];
                    }
                    draft.validSuggestionsByPR.push(...singleComments.prLevel);
                }

                draft.dedupTrace = dedupTrace;
                // File-level only: CreateFileCommentsStage posts every entry as
                // a line comment, and the PR-level ones are already delivered
                // through validSuggestionsByPR above.
                draft.validSuggestions = fileLevelSuggestions;
                draft.discardedSuggestions = allDiscarded;
            });
        } catch (error) {
            const durationMs = Date.now() - startTime;
            // Terminal BYOK (suspended key / no credit) → warn: user's provider
            // config, not a Kodus fault. Real fault stays error.
            this.logger[llmErrorLogLevel(error)]({
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
                    resolvedProvider(context, stageError),
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
                        provider:
                            classification.provider ??
                            resolvedProvider(context, stageError),
                        friendlyMessage: classification.friendlyMessage,
                        httpStatus: classification.httpStatus,
                        providerMessage: classification.providerMessage,
                        model: resolvedModel(context, stageError),
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
    /**
     * The agents' findings placed on the diff: lines snapped to a changed hunk,
     * a file-anchored Kody Rule finding outside every hunk kept for a PR-level
     * comment, any other finding outside every hunk dropped into `allDiscarded`.
     * Called by executeStage; the anchoring evals call it too.
     */
    private anchorSuggestionsToDiff(
        suggestions: Partial<CodeSuggestion>[],
        changedFiles: FileChange[],
        kodyRules: Partial<IKodyRule>[],
        allDiscarded: Partial<CodeSuggestion>[],
    ): Partial<CodeSuggestion>[] {
        // Snap suggestion line numbers to valid diff ranges before passing downstream.
        // GitHub rejects inline comments on lines that aren't part of the diff.
        // A finding whose cited lines don't overlap ANY changed hunk is dropped
        // (snapLinesToDiff returns null) rather than clamped onto an unrelated
        // changed line — clamping was re-anchoring comments about UNCHANGED code
        // onto the diff and shipping them as false positives.
        const changedFilesByName = new Map(
            changedFiles.map((f) => [f.filename, f]),
        );
        const isFileAnchored = fileAnchoredFindingPredicate(kodyRules);
        const validatedSuggestions = suggestions
            .map((s) => {
                const file = changedFilesByName.get(s.relevantFile);
                if (!file) return s;
                const validRanges = extractValidDiffLines(file.patch);
                const snapped = snapLinesToDiff(s, validRanges);
                if (snapped === null) {
                    if (isFileAnchored(s)) {
                        this.logger.log({
                            message: `[AGENT] File-anchored finding for ${s.relevantFile}: lines ${s.relevantLinesStart}-${s.relevantLinesEnd} sit outside every hunk, but the rule declared it needs context beyond the diff — delivering it as a PR-level comment`,
                            context: this.stageName,
                        });
                        return { ...s, fileAnchored: true };
                    }
                    this.logger.log({
                        message: `[AGENT] Dropped out-of-diff suggestion for ${s.relevantFile}: lines ${s.relevantLinesStart}-${s.relevantLinesEnd} do not overlap any changed hunk`,
                        context: this.stageName,
                    });
                    allDiscarded.push({
                        ...s,
                        priorityStatus: PriorityStatus.DISCARDED_BY_CODE_DIFF,
                        deliveryStatus: DeliveryStatus.NOT_SENT,
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
        return validatedSuggestions;
    }

    /**
     * Severities on the v2 scale: a Kody Rule finding takes its rule's severity
     * (the rule matched by the UUID the agent returned), any other finding its
     * own, normalized. Called by executeStage; the funnel evals call it too.
     */
    private normalizeSuggestionSeverities(
        suggestions: Partial<CodeSuggestion>[],
        kodyRules: Partial<IKodyRule>[],
    ) {
        const kodyRulesSuggestions = suggestions.filter(
            (s) => s.label === 'kody_rules',
        );
        const nonKodyRulesSuggestions = suggestions.filter(
            (s) => s.label !== 'kody_rules',
        );

        // Normalize Kody Rules legacy severity (critical/issue/warning) into the
        // v2 severity scale (critical/high/medium/low). The agent returns the rule
        // UUID in brokenKodyRulesIds — use it for exact matching.
        const kodyRulesById = new Map(
            kodyRules.filter((r) => r.uuid).map((r) => [r.uuid!, r]),
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
        return {
            kodyRulesById,
            kodyRulesWithSeverity,
            severityNormalizedNonRules,
        };
    }

    /**
     * One comment per issue: Kody Rule findings merged by rule, the other
     * findings by the dedup model (behind its merge guard), then a finding
     * absorbed into a Kody Rule finding that describes the same issue. A
     * failed pass keeps every finding. Called by executeStage; the dedup evals
     * call it too.
     */
    private async dedupSuggestionStreams(
        severityNormalized: Partial<CodeSuggestion>[],
        prNumber: number,
        context: CodeReviewPipelineContext,
        telemetryMeta: LangfuseTelemetryMetadata | undefined,
    ): Promise<{
        deduped: Partial<CodeSuggestion>[];
        dedupTrace: DedupTraceSummary;
    }> {
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
            status: nonKodyRulesForDedup.length <= 1 ? 'skipped' : 'success',
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
            // O reducer substitui o dedup: agrupar duplicata e escolher o
            // que vale postar sao a mesma decisao vista de dois angulos, e
            // o dedup so fazia a primeira metade. Kody Rules NAO passam por
            // aqui — sao contrato com o cliente, nao candidato a corte.
            const dedupResult = isReducerEnabled()
                ? await this.reduceSuggestions(
                      nonKodyRulesForDedup,
                      context.changedFiles ?? [],
                      prNumber,
                      context.codeReviewConfig?.resolvedModelSlot,
                      telemetryMeta,
                  )
                : await this.deduplicateSuggestions(
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
                    dedupResult.suggestions.length + kodyRulesForDedup.length,
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
        // Custom agent findings sit this one out: against a rule they are
        // the representative (below).
        try {
            const keptNative = new Set(
                await this.crossDedupSuggestionsAgainstKodyRules(
                    dedupedNonRules.filter((s) => !isCustomAgentFinding(s)),
                    kodyRulesForDedup,
                    prNumber,
                    context.codeReviewConfig?.byokConfig,
                    telemetryMeta,
                ),
            );
            dedupedNonRules = dedupedNonRules.filter(
                (s) => isCustomAgentFinding(s) || keptNative.has(s),
            );
        } catch (crossErr) {
            this.logger.warn({
                message: `[DEDUP-CROSS] PR#${prNumber}: cross-stream dedup failed, keeping all`,
                context: this.stageName,
                error: crossErr,
            });
        }

        // A custom agent's finding and a Kody Rule on the same problem:
        // the team asked that agent for it, so the agent's finding is the
        // one kept (#2172). Native findings still yield to the rule above.
        let keptKodyRules = kodyRulesForDedup;
        const customAgentFindings =
            dedupedNonRules.filter(isCustomAgentFinding);
        if (customAgentFindings.length && kodyRulesForDedup.length) {
            try {
                keptKodyRules =
                    await this.crossDedupSuggestionsAgainstKodyRules(
                        kodyRulesForDedup,
                        customAgentFindings,
                        prNumber,
                        context.codeReviewConfig?.byokConfig,
                        telemetryMeta,
                    );
            } catch (crossErr) {
                this.logger.warn({
                    message: `[DEDUP-CROSS] PR#${prNumber}: custom agent vs Kody Rules dedup failed, keeping all`,
                    context: this.stageName,
                    error: crossErr,
                });
            }
        }

        return {
            deduped: [...dedupedNonRules, ...keptKodyRules],
            dedupTrace,
        };
    }

    /**
     * The definitive severity of each finding (the severity classifier; a Kody
     * Rule finding keeps its rule's), then the team's severity threshold, the
     * findings below it moved to `allDiscarded`. Returns the findings that stay.
     * Called by executeStage; the severity evals call it too.
     */
    private async reclassifyAndFilterSeverity(
        suggestions: Partial<CodeSuggestion>[],
        context: CodeReviewPipelineContext,
        allDiscarded: Partial<CodeSuggestion>[],
        // The review's custom agents (#2172); resolved from the context when
        // the caller has none at hand, as the severity evals do.
        customAgentsById?: CustomAgentsById,
    ): Promise<Partial<CodeSuggestion>[]> {
        const agentsById =
            customAgentsById ??
            indexCustomAgents(await this.resolveCustomAgents(context));
        let deduped = suggestions;
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
                context.organizationAndTeamData?.organizationId,
            );
            for (let i = 0; i < deduped.length; i++) {
                const classified = severityMap.get(i);
                if (!classified) {
                    continue;
                }
                const hasKodyRuleSeverity =
                    deduped[i].brokenKodyRulesIds?.length > 0;
                // A custom agent's severity is the team's call too: its
                // floor and comment limit were set against it, and the
                // bug-centric criteria would rank e.g. a missing test low.
                const hasCustomAgentSeverity = !!deduped[i].customAgent;
                if (hasKodyRuleSeverity || hasCustomAgentSeverity) {
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
            context.codeReviewConfig?.suggestionControl?.severityLevelFilter;
        const applyFiltersToKodyRules =
            context.codeReviewConfig?.suggestionControl
                ?.applyFiltersToKodyRules === true;
        if (severityFilter && severityFilter !== 'low' && deduped.length > 0) {
            const acceptedLevels: Record<string, string[]> = {
                critical: ['critical'],
                high: ['critical', 'high'],
                medium: ['critical', 'high', 'medium'],
                low: ['critical', 'high', 'medium', 'low'],
            };
            const accepted =
                acceptedLevels[severityFilter] || acceptedLevels.low;
            const before = deduped.length;
            const keeps = (s: Partial<CodeSuggestion>) =>
                customAgentSeverityVerdict(s, agentsById) ??
                survivesSeverityFilter(s, accepted, applyFiltersToKodyRules);
            const droppedBySeverity = deduped.filter((s) => !keeps(s));
            deduped = deduped.filter(keeps);
            for (const s of droppedBySeverity) {
                allDiscarded.push({
                    ...s,
                    priorityStatus: PriorityStatus.DISCARDED_BY_SEVERITY,
                    deliveryStatus: DeliveryStatus.NOT_SENT,
                });
            }
            if (deduped.length < before) {
                this.logger.log({
                    message: `[AGENT] Post-classification severity filter: ${before - deduped.length} suggestions below ${severityFilter} threshold removed (applyFiltersToKodyRules=${applyFiltersToKodyRules})`,
                    context: this.stageName,
                });
            }
        }
        return deduped;
    }

    private dedupKodyRulesByRuleUuid(
        suggestions: Partial<CodeSuggestion>[],
        prNumber: number,
    ): Partial<CodeSuggestion>[] {
        return mergeKodyRuleFindings(suggestions, (merge) =>
            this.logger.log({
                message:
                    merge.scope === 'pr'
                        ? `[KODY-DEDUP] PR#${prNumber} rule=${merge.ruleUuid} (PR-level) collapsed ${merge.collapsed} findings → 1`
                        : `[KODY-DEDUP] PR#${prNumber} rule=${merge.ruleUuid} (file-level) collapsed ${merge.collapsed} findings → 1 with ${merge.otherLocations} extra locations`,
                context: this.stageName,
            }),
        );
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
            this.embedDedupSuggestion(dup, dupKey, embedCache),
            this.embedDedupSuggestion(keep, keepKey, embedCache),
        ]);
        if (!vecDup || !vecKeep) {
            // Without embeddings this vetoes EVERY merge, which republishes
            // the one duplicate we are most sure about: a scanner fact the
            // model restated. Only that pair overrides the veto — where
            // embeddings work, the full guard still decides, so a wide agent
            // finding that merely overlaps a scanner line is not swallowed.
            if (restatesAnalyzerFinding(dup, keep)) {
                return {
                    honor: true,
                    reason: 'restates-analyzer (no-embed)',
                    score: lexical,
                };
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
    private buildDedupTiebreak(
        byokConfig: NormalizedModel | undefined,
        telemetryMeta: LangfuseTelemetryMetadata | undefined,
        prNumber: number,
    ): (
        a: Partial<CodeSuggestion>,
        b: Partial<CodeSuggestion>,
    ) => Promise<boolean | null> {
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
     * #2097: compares the round's findings with every comment already sent on
     * this PR (`engine/repeat-check.ts`). The history is read again here, not
     * taken from the prompts' 40 most recent: a repeat of an older comment is
     * still a repeat. Only on a PR that has history; the CLI review has none.
     * Returns the history read, so the revision links resolve against it.
     */
    private async dropRepeats(
        context: CodeReviewPipelineContext,
        findings: Partial<CodeSuggestion>[],
        kodyRulesById: ReadonlyMap<string, Partial<IKodyRule>>,
        telemetryMeta?: LangfuseTelemetryMetadata,
    ): Promise<{
        kept: Partial<CodeSuggestion>[];
        repeats: Partial<CodeSuggestion>[];
        history: readonly PrDecisionRecord[] | undefined;
    }> {
        const prNumber = context.pullRequest?.number;
        let history: readonly PrDecisionRecord[] | undefined =
            context.previousDecisions;
        if (!history?.length || !findings.length) {
            return { kept: findings, repeats: [], history };
        }

        const repositoryFullName =
            context.repository?.fullName ||
            context.pullRequest?.base?.repo?.fullName;
        if (this.buildPreviousReviewDecisionsUseCase && repositoryFullName) {
            try {
                const whole =
                    await this.buildPreviousReviewDecisionsUseCase.execute({
                        organizationId:
                            context.organizationAndTeamData.organizationId,
                        prNumber,
                        repositoryFullName,
                        limit: MAX_REPEAT_CHECK_DECISIONS,
                    });
                if (whole.length) history = whole;
            } catch (error) {
                this.logger.warn({
                    message: `[REPEAT-CHECK] PR#${prNumber}: could not read the whole history, checking against the ${history.length} loaded for the prompts`,
                    context: this.stageName,
                    error,
                    metadata: {
                        organizationId:
                            context.organizationAndTeamData?.organizationId,
                        prNumber,
                    },
                });
            }
        }

        const ruleTitleByUuid = new Map<string, string>();
        for (const [uuid, rule] of kodyRulesById) {
            if (rule.title) ruleTitleByUuid.set(uuid, rule.title);
        }
        const result = await checkRepeats(findings, history, {
            byokConfig: context.codeReviewConfig?.resolvedModelSlot,
            ruleTitleByUuid,
            organizationId: context.organizationAndTeamData.organizationId,
            telemetryMetadata: telemetryMeta,
            prNumber,
        });

        this.logger.log({
            message: `[REPEAT-CHECK] PR#${prNumber}: ${result.repeats.length} not posted, ${result.kept.length} kept (history ${history.length}, model ${result.model})`,
            context: this.stageName,
            metadata: {
                organizationId: context.organizationAndTeamData?.organizationId,
                prNumber,
                repeats: result.repeats.map((r) => ({
                    file: r.finding.relevantFile,
                    line: r.finding.relevantLinesStart,
                    label: r.finding.label,
                    earlierId: r.earlier.suggestionId,
                    earlierOutcome: r.earlier.outcome,
                    by: r.by,
                })),
            },
        });

        return {
            kept: result.kept,
            repeats: result.repeats.map((r) => r.finding),
            history,
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
            let absorbedBy: {
                ri: number;
                reason: string;
                score: number;
            } | null = null;
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
     * REDUCER — agrupa, pontua e corta os achados nao-Kody-Rule de um PR.
     *
     * Duas chamadas de LLM por PR (atribuidor + veracidade), no lugar da uma do
     * dedup, e o corte deterministico depois. O prompt precisa do diff inteiro:
     * as duas perguntas sao sobre o CODIGO, nao sobre o texto do achado — quem
     * julga so pelo texto premia prosa confiante, que foi exatamente o que
     * medimos falhar em todos os filtros por candidato.
     *
     * Falha aberta em todos os niveis: sem modelo, sem diff ou com o LLM
     * quebrando, devolve o conjunto de entrada inteiro. Uma revisao com ruido e
     * pior que uma revisao limpa; uma revisao vazia e pior que as duas.
     */
    private async reduceSuggestions(
        suggestions: Partial<CodeSuggestion>[],
        changedFiles: CodeReviewPipelineContext['changedFiles'],
        prNumber: number,
        resolvedSlot?: NormalizedModel,
        telemetryMeta?: LangfuseTelemetryMetadata,
    ): Promise<{
        suggestions: Partial<CodeSuggestion>[];
        trace: DedupTraceSummary;
    }> {
        const asDedupTrace = (t: ReducerTrace): DedupTraceSummary => ({
            status: t.status,
            totalClassifiedCount: t.inputCount,
            kodyRulesSkippedCount: 0,
            nonKodyInputCount: t.inputCount,
            nonKodyOutputCount: t.keptCount,
            finalOutputCount: t.keptCount,
            uniqueCount: t.keptCount,
            groupsCount: t.groupsCount,
            removedCount: t.inputCount - t.keptCount,
            errorMessage: t.errorMessage,
            reducer: t,
        });

        if (!resolvedSlot && !hasManagedModelKey()) {
            this.logger.warn({
                message: `[REDUCER] PR#${prNumber}: no model available, keeping all suggestions`,
                context: this.stageName,
            });
            return {
                suggestions,
                trace: asDedupTrace({
                    status: 'skipped',
                    inputCount: suggestions.length,
                    contractDroppedCount: 0,
                    groupsCount: 0,
                    keptCount: suggestions.length,
                    quota: REDUCER_QUOTA,
                    threshold: REDUCER_THRESHOLD,
                    groups: [],
                }),
            };
        }

        const diff = (changedFiles ?? [])
            .map(
                (f) =>
                    `--- ${f.filename}\n${f.patchWithLinesStr || f.patch || ''}`,
            )
            .join('\n\n');

        const result = await reduceFindings<
            Partial<CodeSuggestion> & ReducerCandidate
        >({
            candidates: suggestions as Array<
                Partial<CodeSuggestion> & ReducerCandidate
            >,
            diff,
            log: (message) =>
                this.logger.log({
                    message: `${message} (PR#${prNumber})`,
                    context: this.stageName,
                }),
            call: ({ schema, prompt, runName, spanName }) =>
                LLM.run({
                    byokConfig: resolvedSlot,
                    schema: jsonSchema(schema as any),
                    user: prompt,
                    runName,
                    spanName,
                    organizationId: telemetryMeta?.organizationId,
                    telemetryMetadata: telemetryMeta,
                    attrs: {
                        type: resolvedSlot ? 'byok' : 'system',
                        prNumber,
                        ...(telemetryMeta?.teamId
                            ? { teamId: telemetryMeta.teamId }
                            : {}),
                    },
                }) as Promise<any>,
        });

        return {
            suggestions: result.suggestions,
            trace: asDedupTrace(result.trace),
        };
    }

    /**
     * Deduplicate suggestions that describe the same issue using LLM.
     * Groups by file, then asks Gemini Flash which suggestions are duplicates.
     */
    /** Removes the suggestions that report no problem. Keeps everything when
     *  there is no model or the call fails: a missed discard only costs a
     *  useless comment, a wrong one would cost a finding. */
    private async sanitizeSuggestions(
        suggestions: Partial<CodeSuggestion>[],
        prNumber: number,
        resolvedSlot?: NormalizedModel,
        telemetryMeta?: LangfuseTelemetryMetadata,
    ): Promise<{
        kept: Partial<CodeSuggestion>[];
        discarded: Partial<CodeSuggestion>[];
    }> {
        if (!suggestions.length || (!resolvedSlot && !hasManagedModelKey())) {
            return { kept: suggestions, discarded: [] };
        }
        try {
            const out = await LLM.run({
                byokConfig: resolvedSlot,
                schema: jsonSchema(SANITIZER_SCHEMA as any),
                user: buildSanitizerPrompt(suggestions),
                runName: 'code-review-suggestion-sanitizer',
                spanName: 'code-review::suggestion-sanitizer',
                organizationId: telemetryMeta?.organizationId,
                telemetryMetadata: telemetryMeta,
                attrs: {
                    type: resolvedSlot ? 'byok' : 'system',
                    prNumber,
                    ...(telemetryMeta?.teamId
                        ? { teamId: telemetryMeta.teamId }
                        : {}),
                },
            });
            const drop = new Set(
                sanitizerDiscardIndices(suggestions.length, out),
            );
            const discarded = suggestions.filter((_, i) => drop.has(i));
            if (discarded.length > 0) {
                this.logger.log({
                    message: `[SANITIZER] PR#${prNumber}: discarded ${discarded.length} of ${suggestions.length} suggestions that report no problem`,
                    context: this.stageName,
                    metadata: {
                        organizationId: telemetryMeta?.organizationId,
                        teamId: telemetryMeta?.teamId,
                        prNumber,
                        discarded: discarded.map((d) => ({
                            relevantFile: d.relevantFile,
                            relevantLinesStart: d.relevantLinesStart,
                            suggestionContent: (d.suggestionContent || '').slice(0, 200),
                        })),
                    },
                });
            }
            return {
                kept: suggestions.filter((_, i) => !drop.has(i)),
                discarded,
            };
        } catch (error) {
            this.logger.warn({
                message: `[SANITIZER] PR#${prNumber}: failed, keeping all suggestions`,
                context: this.stageName,
                error,
                metadata: {
                    organizationId: telemetryMeta?.organizationId,
                    teamId: telemetryMeta?.teamId,
                    prNumber,
                },
            });
            return { kept: suggestions, discarded: [] };
        }
    }

    private async deduplicateSuggestions(
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
                        this.summarizeDedupSuggestion(suggestion),
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

            this.logger.log({
                message: `[DEDUP-DEBUG] PR#${prNumber}: input=${suggestions.length}, groups=${dedupOutput?.groups?.length ?? 0}, unique=${dedupOutput?.unique?.length ?? 0}`,
                context: this.stageName,
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
                        this.logger.warn({
                            message: `${LLM_ENVELOPE_TAG} recovered off-schema dedup output (${reason}) for PR#${prNumber}`,
                            context: this.stageName,
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
                                this.logger.warn({
                                    message: `${LLM_ENVELOPE_TAG} recovered off-schema dedup follow-up output (${reason}) for PR#${prNumber}`,
                                    context: this.stageName,
                                }),
                        },
                    ) as any;
                    if (!Array.isArray(followup?.assignments)) {
                        throw new Error(
                            'the follow-up answer has no assignments',
                        );
                    }
                    ({ groups, unique } = applyDedupFollowup(
                        suggestions.length,
                        groups,
                        unique,
                        leftOut,
                        followup.assignments,
                    ));
                    this.logger.log({
                        message: `[DEDUP-FOLLOWUP] PR#${prNumber}: ${leftOut.length} left out, ${unclassifiedDedupIndices(suggestions.length, groups, unique).length} still left out after the follow-up`,
                        context: this.stageName,
                    });
                } catch (error) {
                    followupError =
                        error instanceof Error ? error.message : String(error);
                    this.logger.warn({
                        message: `[DEDUP-FOLLOWUP] PR#${prNumber}: follow-up for ${leftOut.length} left-out suggestions failed, safety net keeps them`,
                        context: this.stageName,
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
                                // This branch absorbs duplicates without ever
                                // consulting the content guard, so the invariant
                                // has to be repeated here: two scanner findings
                                // are different categories, and absorbing one
                                // drops a whole category's comment.
                                if (
                                    bothFromAnalyzers(dup, suggestions[keepIdx])
                                ) {
                                    if (!addedIndices.has(dupIdx)) {
                                        addedIndices.add(dupIdx);
                                        indexToResult.set(
                                            dupIdx,
                                            result.length,
                                        );
                                        result.push(dup);
                                        uniqueSuggestions.push(
                                            this.summarizeDedupSuggestion(dup),
                                        );
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
                    // The content guard above judged these the same bug, so a
                    // range around or inside the kept one is the same place,
                    // not another location.
                    if (!isSameSpot(dup, kept)) {
                        otherLocations.push(
                            `${dup.relevantFile}:${dup.relevantLinesStart}-${dup.relevantLinesEnd}`,
                        );
                    }

                    this.logger.log({
                        message: `[DEDUP-REMOVED] PR#${prNumber} ${dup.relevantFile}:${dup.relevantLinesStart}-${dup.relevantLinesEnd} [${dup.label}/${dup.severity}] "${dup.oneSentenceSummary || dup.suggestionContent?.substring(0, 80)}"`,
                        context: this.stageName,
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
                (process.env.API_NODE_ENV || process.env.NODE_ENV) ===
                'production';
            if (!isProduction) {
                throw error;
            }
            this.logger.error({
                message: `[DEDUP] PR#${prNumber}: Failed, keeping all ${suggestions.length} suggestions`,
                context: this.stageName,
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
        customAgentNames?: ReadonlyMap<string, string>,
    ): (event: AgentProgressEvent) => void {
        // Track accumulated tool calls per agent for the final entry
        const agentToolCalls = new Map<
            string,
            Array<{ tool: string; args: string }>
        >();

        return (event: AgentProgressEvent) => {
            const stageName = this.getAgentStageName(event);
            const label = this.formatAgentLabel(event, customAgentNames);

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
        // Custom agents share one category; keyed by it, every one of them
        // wrote to the same timeline entry.
        const customSlug = customAgentSlugOf(event);
        const baseName = customSlug
            ? `custom-agent-${customSlug}`
            : event.agentCategory ||
              event.agentName
                  .replace('kodus-', '')
                  .replace('-review-agent', '');

        if (
            event.agentReplicaTotal &&
            event.agentReplicaTotal > 1 &&
            event.agentReplicaIndex
        ) {
            return `AgentReview::${baseName}-r${event.agentReplicaIndex}`;
        }

        return `AgentReview::${baseName}`;
    }

    private formatAgentLabel(
        event: AgentProgressEvent,
        /** Custom agent names by slug, so the timeline names each one. */
        customAgentNames?: ReadonlyMap<string, string>,
    ): string {
        const name =
            event.agentCategory ||
            event.agentName.replace('kodus-', '').replace('-review-agent', '');
        const customSlug = customAgentSlugOf(event);
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
        // "<icon> Agent" for the built-in agents; a custom agent by its name
        // (it fell through to "Performance Agent" before).
        const title = customSlug
            ? customAgentNames?.get(customSlug) || customSlug
            : `${icon} Agent`;
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
                return `${title}${replicaSuffix} — investigating...`;
            case 'batch_started':
                return `${title}${replicaSuffix}${batchSuffix} — starting (${event.batchFiles ?? 0} files)`;
            case 'batch_completed':
                return `${title}${replicaSuffix}${batchSuffix} — ${event.findings ?? 0} findings ${duration}`;
            case 'investigating':
                return `${title}${replicaSuffix}${batchSuffix} — step ${event.step}, ${event.toolCalls?.length ?? 0} tool calls`;
            case 'completed': {
                const suffix =
                    event.source === 'second-chance'
                        ? ' (recovered via second-chance)'
                        : event.source === 'generate-object'
                          ? ' (structured by fallback)'
                          : '';
                return `${title}${replicaSuffix} — ${event.findings ?? 0} findings ${duration}${suffix}`;
            }
            case 'error': {
                if (event.finishReason === 'timeout') {
                    return `${title}${replicaSuffix}${batchSuffix} — timed out after ${duration} (${event.step ?? 0} steps)`;
                }
                if (event.finishReason === 'max-steps') {
                    return `${title}${replicaSuffix}${batchSuffix} — hit step limit (${event.step ?? 0} steps, no findings)`;
                }
                if (event.finishReason === 'no-result') {
                    return `${title}${replicaSuffix}${batchSuffix} — stopped without submitting a result (${event.step ?? 0} steps)`;
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
                return `${title}${replicaSuffix}${batchSuffix} — failed ${duration}${errSummary}`;
            }
            default:
                return `${title}${replicaSuffix}`;
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
                            const prNumber = match.number || match.pull_number;
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

/** A custom agent's run is named `kodus-custom-agent-<slug>`. */
const CUSTOM_AGENT_RUN_PREFIX = 'kodus-custom-agent-';

function customAgentSlugOf(event: AgentProgressEvent): string | undefined {
    return event.agentName?.startsWith(CUSTOM_AGENT_RUN_PREFIX)
        ? event.agentName.slice(CUSTOM_AGENT_RUN_PREFIX.length) || undefined
        : undefined;
}

/** The statuses the outcome log counts as dropped by the checks. */
const CHECK_DROPS = new Set<PriorityStatus | undefined>([
    PriorityStatus.DISCARDED_BY_SAFEGUARD,
    PriorityStatus.DISCARDED_BY_VERIFY_ERROR,
]);
