import { createLogger } from '@libs/core/log/logger';
import {
    attachClassification,
    classifyLLMError,
    getClassification,
} from '@libs/llm/error-classifier';
import { Injectable, Optional } from '@nestjs/common';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';

import { ObservabilityService } from '@libs/core/log/observability.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { assignFileTiers, computeFileScores } from '@libs/code-review/infrastructure/agents/engine/file-priority-scorer';
import {
    PROMPT_BUDGET_RATIO,
    assertContextWindowFitsOverhead,
    estimateNonDiffOverheadTokens,
    estimatePromptTokens,
    applyLargePrAggressiveFilter,
    chunkFilesByTokenBudget,
} from '@libs/code-review/infrastructure/agents/collaborators/context-fit-planner';
import {
    buildSystemPrompt as buildSystemPromptFor,
    buildUserPrompt as buildUserPromptFor,
    type PromptAgentMeta,
} from '@libs/code-review/infrastructure/agents/prompts/prompt-builder';
import { resolveContextWindow } from '@libs/llm/model-context-window';
import { LLM_TASK } from '@libs/llm/byok-config';
import {
    type ReviewWarning,
} from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import { resolveAdaptiveProfile } from '@libs/code-review/infrastructure/agents/engine/adaptive-fit';
import { runAgentLoopViaCore } from '@libs/code-review/infrastructure/agents/core/core-agent-loop.adapter';
import {
    type AgentLoopSecrets,
    type ReviewAgentIdentity,
    type ReviewAgentInput,
    type ReviewAgentOutput,
    type AgentProgressEvent,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';
import { CoverageTier } from '@libs/code-review/infrastructure/agents/engine/coverage-ledger';
import { mapAgentFindings } from '@libs/code-review/infrastructure/agents/collaborators/finding-mapper';
import {
    resolveReviewAgentModel,
    type AgentModelParams,
} from '@libs/code-review/infrastructure/agents/collaborators/model-factory';
import { providerErrorFromResult } from '@libs/code-review/infrastructure/agents/collaborators/provider-error';
import {
    recordAgentUsageSpans,
    runAgentWithTrace,
} from '@libs/code-review/infrastructure/agents/collaborators/review-observability';
import { runChunkedReview } from '@libs/code-review/infrastructure/agents/collaborators/batch-runner';
import { AgentProgressReporter } from '@libs/code-review/infrastructure/agents/collaborators/agent-progress-reporter';

/**
 * Hard cap on execute() → executeChunked() → execute() recursion. Set to
 * 2 because the only legitimate recursion is one level deep (root review
 * fans out into per-batch executes). Anything beyond that means the
 * chunker couldn't reduce the file count and we'd loop forever — see
 * executeChunked's fail-fast guard, which catches the same condition at
 * its source. This guard remains as defense-in-depth.
 */
const MAX_RECURSION_DEPTH = 2;

/**
 * Abstract base class for code review agents (Bugs, Security, Performance).
 *
 * Uses Vercel AI SDK with native function calling instead of text-based ReAct.
 * This works with any model (BYOK) because the SDK translates tool definitions
 * to each provider's native format (OpenAI function_call, Anthropic tool_use,
 * Gemini function_calling, OpenRouter, etc.).
 *
 * Subclasses only define:
 * - identity (name, description, goal, expertise)
 * - category-specific system prompt
 * - category label
 */
@Injectable()
export abstract class BaseCodeReviewAgentProvider {
    private readonly agentLogger = createLogger('CodeReviewAgent');

    constructor(
        protected readonly permissionValidationService: PermissionValidationService,
        protected readonly observabilityService: ObservabilityService,
        /** Optional: when injected, enables the `searchDocs` tool on the
         *  agent loop. Falsy when API_EXA_KEY is not configured. */
        @Optional()
        protected readonly documentationSearchService?: DocumentationSearchExaService,
        /** Optional: when injected, wires BYOK LLM failures into the
         *  notification engine so OWNER gets `byok.llm_errors_threshold`
         *  after sustained errors. Falsy in the CLI/eval paths. */
        @Optional()
        protected readonly byokErrorCounter?: ByokErrorCounter,
    ) {}

    protected abstract getIdentity(): ReviewAgentIdentity;
    /**
     * Return the category-specific chunk that gets embedded in the system
     * prompt. Receives `input` so subclasses can include per-request data
     * (e.g. the kody-rules agent renders the current team rules) without
     * stashing it on instance state — keeping the provider safe to share
     * across concurrent reviews.
     */
    protected abstract getCategoryPrompt(input: ReviewAgentInput): string;
    protected abstract getCategoryLabel(): string;

    protected supportsMixedLabels(): boolean {
        return false;
    }

    protected getAllowedSuggestionLabels(
        _input: ReviewAgentInput,
    ): Array<'bug' | 'security' | 'performance'> {
        const category = this.getCategoryLabel();
        if (
            category === 'bug' ||
            category === 'security' ||
            category === 'performance'
        ) {
            return [category];
        }

        return ['bug'];
    }

    /**
     * Execute the agent against the provided changed files.
     */
    async execute(input: ReviewAgentInput): Promise<ReviewAgentOutput> {
        const startTime = Date.now();
        const baseIdentity = this.getIdentity();
        const identity: ReviewAgentIdentity = {
            ...baseIdentity,
            name: input.agentRuntimeName || baseIdentity.name,
        };
        const agentCategory = this.getCategoryLabel();

        const recursionDepth = input.recursionDepth ?? 0;
        if (recursionDepth >= MAX_RECURSION_DEPTH) {
            this.agentLogger.error({
                message: `[AGENT] ${identity.name} recursion limit reached (depth=${recursionDepth}); aborting to protect the worker heap`,
                context: identity.name,
                metadata: {
                    prNumber: input.prNumber,
                    recursionDepth,
                    maxRecursionDepth: MAX_RECURSION_DEPTH,
                    filesCount: input.changedFiles.length,
                },
            });
            throw new Error('AGENT_RECURSION_LIMIT_EXCEEDED');
        }

        // When this execute() call is one batch of a chunked review
        // (executeChunked has split a large PR by token budget), enrich
        // every progress event emitted from inside this call with batch
        // info so the UI can render "batch i/N · step k" labels without
        // each emit site having to know about chunking.
        if (
            input.batchIndex &&
            input.batchTotal &&
            input.batchTotal > 1 &&
            input.onAgentProgress
        ) {
            const inner = input.onAgentProgress;
            const enrichedInput = {
                ...input,
                onAgentProgress: (event: AgentProgressEvent) =>
                    inner({
                        ...event,
                        batchIndex: event.batchIndex ?? input.batchIndex,
                        batchTotal: event.batchTotal ?? input.batchTotal,
                    }),
            };
            input = enrichedInput;
        }

        // Progress events all repeat the same 4 identity fields — capture once.
        const progress = new AgentProgressReporter(input.onAgentProgress, {
            agentName: identity.name,
            agentCategory,
            agentReplicaIndex: input.agentReplicaIndex,
            agentReplicaTotal: input.agentReplicaTotal,
        });

        this.agentLogger.debug({
            message: `[AGENT] Starting ${identity.name} for PR#${input.prNumber}`,
            context: identity.name,
            metadata: {
                organizationId: input.organizationAndTeamData?.organizationId,
                teamId: input.organizationAndTeamData?.teamId,
                prNumber: input.prNumber,
                filesCount: input.changedFiles.length,
            },
        });

        // Resolve BYOK config + model (org config → per-repo override → trial
        // default). Scoped locally to prevent cross-review races. → ModelFactory.
        const { byokConfig, main: mainModel } = await resolveReviewAgentModel(
            input,
            this.permissionValidationService,
        );
        // Preflight (context window + warnings) runs against the resolved model.
        // `effectiveModelName` tracks the model that actually ran (there is one
        // model per run now — no fallback provider swap).
        const modelName = mainModel.modelName;
        let effectiveModelName = mainModel.modelName;

        this.agentLogger.log({
            message: `[AGENT] ${identity.name} using model: ${modelName}`,
            context: identity.name,
        });

        // Check if the estimated prompt exceeds the context window budget
        // and needs chunking. The measurement accounts for diff + callGraph
        // + PR context + coverage list + static overhead (system prompt +
        // tool schemas) — not just the diff.
        const contextWindow = resolveContextWindow({
            byokMaxInputTokens: mainModel.maxInputTokens,
            modelName,
        });
        // Resolve adaptive-fit profile from the same context window the
        // preflight will check against. Prefer the stage-supplied profile
        // when present (it's authoritative — the stage owns callGraph and
        // skipHeavyPasses decisions and we need to agree). Falling back
        // to local resolution covers callers (CLI trial, ad-hoc tests)
        // that didn't go through the stage.
        const adaptiveProfile =
            input.adaptiveProfile ?? resolveAdaptiveProfile(contextWindow);
        // Ensure downstream estimators (estimateNonDiffOverheadTokens,
        // estimatePromptTokens, the prompt builders) all see the same
        // profile — without this the preflight would be computing the
        // FULL overhead even when the compact path will fire, throwing
        // before the strategies could rescue the run (the exact failure
        // mode caught by the first post-fix benchmark).
        if (!input.adaptiveProfile) {
            input = { ...input, adaptiveProfile };
        }
        // Track which adaptive strategies fired so they bubble up to the
        // orchestrator as ReviewWarning entries → end-review PR comment.
        const agentWarnings: ReviewWarning[] = [];
        const emitWarning = (kind: ReviewWarning['kind'], detail?: string) => {
            agentWarnings.push({
                kind,
                reason: 'small_context_window',
                contextWindowTokens: contextWindow,
                modelName,
                detail,
                agentName: identity.name,
            });
        };
        // Fail fast when the configured model's context window cannot
        // even hold the agent's static overhead. Without this, the loop
        // would run to AGENT_TIMEOUT_MS (30 min) while the LLM 400s on
        // every retry — see runAgentLoop. Surfaces as CONTEXT_OVERFLOW
        // via classifyLLMError → friendlyMessage on lastReviewError.
        assertContextWindowFitsOverhead({
            input,
            contextWindow,
            modelName,
        });
        if (adaptiveProfile.compactPrompt) {
            emitWarning('PROMPT_COMPACTED');
        }
        const promptBudget = Math.floor(contextWindow * PROMPT_BUDGET_RATIO);
        // Adaptive fit: when the profile says so, truncate per-file
        // diffs before estimating tokens. Each truncated file gets a
        // marker so the agent knows context is missing. Skipped when
        // the file already fits under the cap (no behavior change).
        if (adaptiveProfile.maxDiffChars && input.changedFiles?.length) {
            const cap = adaptiveProfile.maxDiffChars;
            const truncatedNames: string[] = [];

            const truncatedFiles = input.changedFiles.map((f) => {
                const diff = f.patchWithLinesStr ?? f.patch ?? '';

                if (diff.length <= cap) {
                    return f;
                }

                const head = diff.slice(0, cap);
                const marker = `\n... (diff truncated to ${cap} chars by adaptive-fit; readFile for the rest)`;

                truncatedNames.push(f.filename ?? 'unknown');

                return f.patchWithLinesStr
                    ? { ...f, patchWithLinesStr: head + marker }
                    : { ...f, patch: head + marker };
            });

            if (truncatedNames.length > 0) {
                input = { ...input, changedFiles: truncatedFiles };
                this.agentLogger.log({
                    message: `[AGENT] ${identity.name} adaptive-fit: truncated ${truncatedNames.length} long diffs to ${cap} chars`,
                    context: identity.name,
                    metadata: {
                        truncatedFiles: truncatedNames,
                        maxDiffChars: cap,
                    },
                });
                emitWarning(
                    'DIFF_TRUNCATED',
                    `${truncatedNames.length} files truncated to ${cap} chars`,
                );
            }
        }

        let estimatedPromptTokens = estimatePromptTokens(input);

        // Large-PR aggressive filter + priority tiering: when the estimated
        // prompt already exceeds the single-batch budget AND we're not in
        // deep mode, drop low-signal files (tests, docs, styles), then
        // score the remaining set and mark the critical tier. Tiering lets
        // coverage relax from "inspect every file" to "inspect criticals
        // + 70% total", which is what actually keeps the main loop from
        // burning steps on UI leaves in a huge PR.
        //
        // Adaptive fit (`compact+`): drop the `reviewMode !== 'deep'`
        // gate AND the prompt-overflow gate so the low-signal filter
        // always fires on small windows. Deep-mode small-window reviews
        // are still better than no review at all.
        let fileTiers: Map<string, CoverageTier> | undefined;
        const shouldFireFilter =
            input.changedFiles.length > 1 &&
            (adaptiveProfile.lowSignalFilterUnconditional ||
                (estimatedPromptTokens > promptBudget &&
                    input.reviewMode !== 'deep'));

        if (shouldFireFilter) {
            const filesBefore = input.changedFiles.length;
            const filteredFiles = applyLargePrAggressiveFilter(
                input.changedFiles,
            );

            if (filteredFiles.length < filesBefore) {
                input = { ...input, changedFiles: filteredFiles };
                const filteredTokens = estimatePromptTokens(input);

                this.agentLogger.log({
                    message: `[AGENT] ${identity.name} large-PR aggressive filter dropped ${filesBefore - filteredFiles.length} low-signal files (tests/md/css): ${estimatedPromptTokens} → ${filteredTokens} prompt tokens`,
                    context: identity.name,
                    metadata: {
                        filesBefore,
                        filesAfter: filteredFiles.length,
                        tokensBefore: estimatedPromptTokens,
                        tokensAfter: filteredTokens,
                        reviewMode: input.reviewMode,
                    },
                });

                if (adaptiveProfile.lowSignalFilterUnconditional) {
                    emitWarning(
                        'LOW_SIGNAL_FILES_DROPPED',
                        `${filesBefore - filteredFiles.length} files dropped (tests/md/css)`,
                    );
                }
            }

            const scores = computeFileScores(
                input.changedFiles,
                input.callGraphJson,
            );
            fileTiers = assignFileTiers(scores);
            // Adaptive fit (`minimal`): force every file to `optional`
            // so the user prompt renders hunk-headers only (cutting
            // ~80–90% of diff chars). The agent must readFile each hunk
            // it cares about — slower per-finding but the only way to
            // squeeze a multi-file PR into an 8K–16K window.
            if (adaptiveProfile.allOptional) {
                for (const filename of fileTiers.keys()) {
                    fileTiers.set(filename, 'optional');
                }
                emitWarning('HUNK_HEADERS_ONLY');
            }

            let criticalCount = 0;
            let warmCount = 0;
            let optionalCount = 0;

            for (const tier of fileTiers.values()) {
                if (tier === 'critical') {
                    criticalCount++;
                } else if (tier === 'warm') {
                    warmCount++;
                } else {
                    optionalCount++;
                }
            }

            const hasCallGraph = !!input.callGraphJson?.edges?.length;

            this.agentLogger.debug({
                message: `[AGENT] ${identity.name} large-PR priority tiering: critical=${criticalCount} warm=${warmCount} optional=${optionalCount} / ${input.changedFiles.length} (callGraph=${hasCallGraph ? 'yes' : 'fallback'})`,
                context: identity.name,
                metadata: {
                    totalFiles: input.changedFiles.length,
                    criticalCount,
                    warmCount,
                    optionalCount,
                    usedCallGraph: hasCallGraph,
                    reviewMode: input.reviewMode,
                },
            });
            // Stash so buildUserPrompt and formatDiffs can render tiered
            // output without recomputing scores.
            input = { ...input, fileTiers };
            // Re-estimate prompt tokens now that optional files will be
            // rendered as hunk headers only — this often brings a large
            // PR back under the single-batch budget.
            estimatedPromptTokens = estimatePromptTokens(input);
        }

        if (
            estimatedPromptTokens > promptBudget &&
            input.changedFiles.length > 1
        ) {
            // Per-chunk diff budget: prompt budget minus the FULL non-diff
            // overhead every chunk pays again (static system prompt + tool
            // schemas, callGraph, coverage list, PR context). Previously we
            // only subtracted the static piece, so chunkDiffBudget was too
            // generous: a PR whose diffs alone fit in the budget but whose
            // total prompt overflowed by ~2% produced 1 chunk containing
            // every file, tripping the recursion guard and killing the
            // review. Aligning this with estimatePromptTokens (which uses
            // the same helper for the split decision) keeps the two ends
            // from drifting.
            const overheadTokens = estimateNonDiffOverheadTokens(input);
            const chunkDiffBudget = Math.max(
                promptBudget - overheadTokens,
                Math.floor(contextWindow * 0.3),
            );
            // Pre-check the chunker BEFORE recursing: if it would
            // produce a single chunk containing every file (small files
            // packing comfortably), splitting won't help — the prompt
            // overflow is from the overhead, not the diffs. Falling
            // through to runAgentLoop on the same stack frame lets the
            // agent loop's mid-stream compressor handle marginal
            // overflow, and the assertPromptFitsInContext preflight
            // catches the genuine "won't fit at all" case. Without this
            // check, executeChunked would recurse → execute() at depth 1
            // → same chunking decision → infinite recursion bounded by
            // MAX_RECURSION_DEPTH = an opaque user-facing failure.
            const previewChunks = chunkFilesByTokenBudget(
                input.changedFiles,
                chunkDiffBudget,
            );

            if (
                previewChunks.length === 1 &&
                previewChunks[0].length === input.changedFiles.length
            ) {
                this.agentLogger.log({
                    message: `[AGENT] ${identity.name} chunker would return 1 chunk for ${input.changedFiles.length} files; running single batch directly (overhead, not diff size, is the constraint)`,
                    context: identity.name,
                    metadata: {
                        prNumber: input.prNumber,
                        filesCount: input.changedFiles.length,
                        overheadTokens,
                        chunkDiffBudget,
                        estimatedPromptTokens,
                        promptBudget,
                    },
                });
                // Fall through to the single-batch runAgentLoop path
                // below by NOT entering executeChunked. The variables
                // (estimatedPromptTokens, fileTiers, etc) are already
                // set and runAgentLoop's own preflight + compressor
                // will handle the rest.
            } else {
                this.agentLogger.warn({
                    message: `[AGENT] ${identity.name} prompt exceeds context budget (${estimatedPromptTokens} tokens > ${promptBudget} budget), splitting into batches`,
                    context: identity.name,
                    metadata: {
                        estimatedPromptTokens,
                        promptBudget,
                        chunkDiffBudget,
                        contextWindow,
                        filesCount: input.changedFiles.length,
                    },
                });

                return runChunkedReview(input, {
                    identity,
                    agentCategory,
                    startTime,
                    diffBudget: chunkDiffBudget,
                    // Parent-level warnings emitted before the chunk split
                    // (PROMPT_COMPACTED, DIFF_TRUNCATED, LOW_SIGNAL_FILES_DROPPED,
                    // HUNK_HEADERS_ONLY) — forward so they're preserved in the
                    // final aggregate. Each per-batch execute() resolves the
                    // profile again and may emit additional dedup-able copies;
                    // dedupReviewWarnings in the orchestrator folds them.
                    parentWarnings: agentWarnings,
                    runBatch: (batchInput) => this.execute(batchInput),
                    logger: this.agentLogger,
                });
            }
        }

        const systemPrompt = this.buildSystemPrompt(input);
        const userPrompt = this.buildUserPrompt(input);

        this.agentLogger.log({
            message: `[AGENT] ${identity.name} prompt context: memoryRules=${input.memoryRules?.length ?? 0}, overrides=${!!input.v2PromptOverrides}, language=${input.languageResultPrompt || 'default'}`,
            context: identity.name,
        });

        // Emit progress: agent started
        progress.send({ status: 'started' });

        try {
            // Secrets are passed via closure (not as tracing arg) so that
            // Langfuse span I/O never serialises API keys, tokens, or
            // NestJS service instances (which carry ConfigService with all env vars).
            const byokErrorCounter = this.byokErrorCounter;
            const loopSecrets: AgentLoopSecrets = {
                remoteCommands: input.remoteCommands,
                byokConfig,
                gitHubToken: input.gitHubToken,
                linkedRepoAccess: input.linkedRepoAccess,
                documentationSearchService: this.documentationSearchService,
                documentationSearchOptions: {
                    organizationAndTeamData: input.organizationAndTeamData,
                    prNumber: input.prNumber,
                    byokConfig,
                },
                byokErrorReporter: byokErrorCounter
                    ? (entry) => {
                          // Fire-and-forget; ByokErrorCounter.record never
                          // throws, but we still drop the promise so the
                          // LLM call path returns immediately.
                          void byokErrorCounter.record(entry);
                      }
                    : undefined,
            };

            // The single agent-loop run against the one resolved model. There is
            // no fallback provider swap (removed in 04b-05) — a provider failure
            // fails the run. Progress counters live inside so it starts fresh.
            const runAttempt = async (modelParams: AgentModelParams) => {
                effectiveModelName = modelParams.modelName;

                // Accumulate tool calls for batch progress updates
                const recentToolCalls: AgentProgressEvent['toolCalls'] = [];
                let stepCount = 0;
                const PROGRESS_BATCH_SIZE = 5;

                const loopParams = {
                    model: modelParams.model,
                    systemPrompt,
                    userPrompt,
                    agentName: identity.name,
                    telemetryMetadata: {
                        organizationId:
                            input.organizationAndTeamData?.organizationId,
                        teamId: input.organizationAndTeamData?.teamId,
                        pullRequestId: input.prNumber,
                        repositoryId: input.repositoryId,
                        provider: modelParams.modelName,
                    },
                    changedFiles: input.changedFiles,
                    prNumber: input.prNumber,
                    repositoryFullName: input.repositoryFullName,
                    baseBranch: input.baseBranch,
                    callGraph: input.callGraph,
                    fileTiers,
                    reviewMode: input.reviewMode,
                    maxSteps: input.maxSteps,
                    // Heavy-pass gating: forwarded explicitly because loopParams
                    // is built field-by-field. Without this line, callers like
                    // KodyRulesAgentProvider that opt out of synthesis-rescue
                    // would have their preference silently dropped here.
                    skipHeavyPasses: input.skipHeavyPasses,
                    skipSynthesisRescue: input.skipSynthesisRescue,
                    // HEAVY opt-in (`--heavy`) — forwarded explicitly, same reason
                    // as skipHeavyPasses above: loopParams is built field-by-field,
                    // so without this line the resample passes never run.
                    heavy: input.heavy,
                    outlineFirst: input.outlineFirst,
                    // Context window is sized against the resolved model.
                    contextWindowTokens: contextWindow,
                    reasoningEffort: modelParams.reasoningEffort,
                    reasoningConfigOverride: modelParams.reasoningConfigOverride,
                    byokProvider: modelParams.byokProvider,
                    // Without this the reasoning mapper can't tell an Opus 5
                    // from a Sonnet 4.5 and has to guess the thinking shape —
                    // and the wrong guess is a 400 that fails the review.
                    modelName: modelParams.modelName,
                    // Drives the BYOK concurrency limiter bucket + wrapper role.
                    byokRole: modelParams.role,
                    openrouterProviderOrder: modelParams.openrouterProviderOrder,
                    openrouterAllowFallbacks:
                        modelParams.openrouterAllowFallbacks,
                    parentSignal: input.parentSignal,

                    onStepFinish: (step: any) => {
                        stepCount++;
                        if (step.toolCalls) {
                            for (const tc of step.toolCalls) {
                                this.agentLogger.log({
                                    message: `[AGENT-TOOL] PR#${input.prNumber} ${identity.name} tool=${tc.toolName}`,
                                    context: identity.name,
                                });
                                recentToolCalls.push({
                                    tool: tc.toolName,
                                    args: JSON.stringify(
                                        tc.args || tc.input || {},
                                    ).substring(0, 100),
                                });
                            }
                        }
                        // Batch progress update every N steps
                        if (
                            stepCount % PROGRESS_BATCH_SIZE === 0 &&
                            recentToolCalls.length > 0
                        ) {
                            progress.send({
                                status: 'investigating',
                                step: stepCount,
                                toolCalls: [...recentToolCalls],
                            });
                            recentToolCalls.length = 0; // Clear after sending
                        }
                    },
                };

                // The agent harness is the only engine now (legacy loop retired).
                const loopFn = runAgentLoopViaCore;

                // Span input: strip the changedFiles patches (large) from
                // loopParams so the trace records shape without every diff.
                const { changedFiles: _cf, ...restParams } = loopParams as any;
                const safeInput = {
                    ...restParams,
                    ...(_cf && {
                        changedFiles: _cf.map(
                            ({ patch: _patch, ...rest }: Record<string, any>) =>
                                rest,
                        ),
                    }),
                };

                return runAgentWithTrace(
                    {
                        traceName: identity.name,
                        organizationId:
                            input.organizationAndTeamData?.organizationId,
                        teamId: input.organizationAndTeamData?.teamId,
                        prNumber: input.prNumber,
                        repositoryId: input.repositoryId,
                    },
                    safeInput,
                    () => loopFn(loopParams, loopSecrets),
                );
            };

            // Single run against the one resolved model — no fallback provider
            // swap (removed in 04b-05).
            const agentResult = await runAttempt(mainModel);

            // The provider run failed. Throw so the orchestrator records a real
            // failure — otherwise the harness's swallowed error (a non-throwing
            // error-status result, finishReason 'error') would surface as a
            // silent "0 suggestions, 0 failures" SUCCESS, masking a provider
            // outage. The thrown message is classified (classifyLLMError) into
            // the end-review comment's failure reason.
            const providerError = providerErrorFromResult(agentResult);
            if (providerError) {
                throw providerError;
            }

            const durationMs = Date.now() - startTime;

            // Per-agent usage spans (main + verify). Best-effort. → ReviewObservability.
            await recordAgentUsageSpans({
                agentResult,
                modelName: effectiveModelName,
                isByok: !!byokConfig,
                byokModelId: byokConfig?.byokModelId,
                credentialId: byokConfig?.credentialId,
                route: LLM_TASK.codeReview,
                categoryLabel: this.getCategoryLabel(),
                identityName: identity.name,
                organizationId: input.organizationAndTeamData?.organizationId,
                teamId: input.organizationAndTeamData?.teamId,
                prNumber: input.prNumber,
                durationMs,
                observability: this.observabilityService,
            });

            // Map raw agent findings → CodeSuggestion (path validation,
            // kody-rule UUID recovery, label/severity). Extracted to FindingMapper.
            const mapped = mapAgentFindings(agentResult, {
                changedFiles: input.changedFiles,
                kodyRules: input.kodyRules,
                prNumber: input.prNumber,
                isKodyRules: this.getCategoryLabel() === 'kody_rules',
                identityName: this.getIdentity().name,
                labelPolicy: {
                    categoryLabel: this.getCategoryLabel(),
                    allowedLabels: this.getAllowedSuggestionLabels(input),
                    supportsMixed: this.supportsMixedLabels(),
                },
                logger: this.agentLogger,
            });
            const suggestions = mapped.suggestions;

            // Emit progress: agent completed
            // Only mark as error if the agent hit a hard limit (timeout or MAX_STEPS with tool-calls finish).
            // source=empty with finishReason=stop is legitimate (agent investigated and found nothing).
            const hitHardLimit =
                agentResult.finishReason === 'timeout' ||
                (agentResult.source === 'empty' &&
                    agentResult.finishReason === 'tool-calls');
            const stopReason: ReviewAgentOutput['finishReason'] =
                agentResult.finishReason === 'timeout'
                    ? 'timeout'
                    : hitHardLimit
                      ? 'max-steps'
                      : 'stop';

            progress.send({
                status: hitHardLimit ? 'error' : 'completed',
                findings: suggestions.length,
                durationMs,
                totalTokens: agentResult.usage.totalTokens,
                step: agentResult.steps,
                finishReason: stopReason,
                source: agentResult.source,
                coverage: agentResult.coverage,
                verification: agentResult.verification,
                anomalies: agentResult.anomalies,
                suggestionsPreview: suggestions.slice(0, 10).map((s) => ({
                    relevantFile: s.relevantFile,
                    relevantLinesStart: s.relevantLinesStart,
                    relevantLinesEnd: s.relevantLinesEnd,
                    oneSentenceSummary: s.oneSentenceSummary,
                    label: s.label,
                    severity: s.severity,
                })),
                toolCalls: agentResult.toolCalls.map((tc) => ({
                    tool: tc.toolName || tc.tool,
                    args: JSON.stringify(tc.args).substring(0, 100),
                })),
            });

            const cacheReadTokens =
                (agentResult.usage as any).cacheReadTokens ?? 0;
            const cacheWriteTokens =
                (agentResult.usage as any).cacheWriteTokens ?? 0;
            const cacheHitRate =
                agentResult.usage.inputTokens > 0
                    ? Math.round(
                          (cacheReadTokens / agentResult.usage.inputTokens) *
                              100,
                      )
                    : 0;

            this.agentLogger.debug({
                message: `[AGENT] ${identity.name} completed for PR#${input.prNumber}: ${suggestions.length} suggestions in ${durationMs}ms (source=${agentResult.source}, steps=${agentResult.steps}, tools=${agentResult.toolCalls.length}, input=${agentResult.usage.inputTokens} [cacheRead=${cacheReadTokens}, hit=${cacheHitRate}%], output=${agentResult.usage.outputTokens}, total=${agentResult.usage.totalTokens})`,
                context: identity.name,
                metadata: {
                    organizationId:
                        input.organizationAndTeamData?.organizationId,
                    prNumber: input.prNumber,
                    suggestionsCount: suggestions.length,
                    durationMs,
                    source: agentResult.source,
                    steps: agentResult.steps,
                    toolCalls: agentResult.toolCalls.length,
                    inputTokens: agentResult.usage.inputTokens,
                    cacheReadTokens,
                    cacheWriteTokens,
                    cacheHitRate,
                    outputTokens: agentResult.usage.outputTokens,
                    totalTokens: agentResult.usage.totalTokens,
                    finishReason: agentResult.finishReason,
                    model: effectiveModelName,
                    coverage: agentResult.coverage,
                    verification: agentResult.verification,
                    anomalies: agentResult.anomalies,
                },
            });

            return {
                suggestions,
                discardedBySeverity: mapped.discardedBySeverity,
                discardedByVerify: mapped.discardedByVerify,
                agentName: identity.name,
                agentCategory,
                agentReplicaIndex: input.agentReplicaIndex,
                agentReplicaTotal: input.agentReplicaTotal,
                turnsUsed: agentResult.steps,
                durationMs,
                // Merge agent-loop-emitted warnings (currently none — the
                // loop's warnings: [] is the PR1 placeholder) with the
                // strategy warnings emitted in this provider above.
                warnings: [...agentWarnings, ...(agentResult.warnings ?? [])],
                // Carry the cut-short signal out of the provider. It used to
                // stop at `progress.send` (UI only), so the pipeline had no way
                // to tell "found nothing" from "never finished looking".
                hitHardLimit,
                finishReason: stopReason,
            };
        } catch (error) {
            const durationMs = Date.now() - startTime;
            const errMsg =
                error instanceof Error ? error.message : String(error);
            const errName = error instanceof Error ? error.name : undefined;

            // Classify HERE, while the error still carries its status and
            // response body, and attach the result so every downstream reader
            // (orchestrator, stage, PR comment, UI label) shares one actionable
            // sentence instead of re-deriving from a lossy copy.
            const classification =
                getClassification(error) ??
                classifyLLMError(
                    error,
                    typeof byokConfig?.provider === 'string'
                        ? byokConfig.provider
                        : undefined,
                );
            if (error instanceof Error) {
                attachClassification(error, classification);
            }

            progress.send({
                status: 'error',
                durationMs,
                errorMessage: errMsg.substring(0, 500),
                errorName: errName,
                errorFriendlyMessage: classification.friendlyMessage,
            });
            this.agentLogger.error({
                message: `[AGENT] ${identity.name} failed for PR#${input.prNumber} after ${durationMs}ms: ${errMsg}`,
                context: identity.name,
                error,
                metadata: {
                    prNumber: input.prNumber,
                    durationMs,
                    model: effectiveModelName,
                    errorName: errName,
                    errorStack:
                        error instanceof Error
                            ? error.stack?.substring(0, 500)
                            : undefined,
                },
            });
            // Re-throw so the orchestrator's Promise.allSettled captures this
            // as a rejected agent and accounts for it in `failures[]`. Before
            // this, we returned `{ suggestions: [], turnsUsed: 0 }` which the
            // orchestrator treated as a fulfilled-with-no-findings result,
            // silently masking real crashes as legitimate "0 suggestions".
            throw error;
        }
    }

    /** Subclass-specific bits the (pure) prompt builders need. */
    private promptMeta(input: ReviewAgentInput): PromptAgentMeta {
        return {
            identity: this.getIdentity(),
            categoryPrompt: this.getCategoryPrompt(input),
            categoryLabel: this.getCategoryLabel(),
            allowedLabels: this.getAllowedSuggestionLabels(input),
            supportsMixed: this.supportsMixedLabels(),
        };
    }

    private buildSystemPrompt(input: ReviewAgentInput): string {
        return buildSystemPromptFor(input, this.promptMeta(input));
    }

    /** Protected so KodyRulesAgentProvider can override the user prompt. */
    protected buildUserPrompt(input: ReviewAgentInput): string {
        return buildUserPromptFor(input, this.promptMeta(input));
    }
}
