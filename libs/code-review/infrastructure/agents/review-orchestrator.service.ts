import { createLogger } from '@libs/core/log/logger';
import { llmErrorLogLevel } from '@libs/llm/error-classifier';
import { Injectable, Optional } from '@nestjs/common';

import {
    CodeSuggestion,
    CustomAgentConfig,
    ReviewOptions,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { BugAgentProvider } from '@libs/code-review/infrastructure/agents/providers/bug-agent.provider';
import { SecurityAgentProvider } from '@libs/code-review/infrastructure/agents/providers/security-agent.provider';
import { PerformanceAgentProvider } from '@libs/code-review/infrastructure/agents/providers/performance-agent.provider';
import { GeneralistAgentProvider } from '@libs/code-review/infrastructure/agents/providers/generalist-agent.provider';
import { KodyRulesAgentProvider } from '@libs/code-review/infrastructure/agents/providers/kody-rules-agent.provider';
import { CustomAgentProviderFactory } from '@libs/code-review/infrastructure/agents/providers/custom-agent.provider';
import {
    customAgentSlug,
    filesInAgentScope,
    ignoredFilesInAgentScope,
    scopeCallGraph,
    selectCustomAgents,
} from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-scope';
import type { CustomAgentRun } from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-summary';
import type { ResolvedKnowledge } from '@libs/code-review/infrastructure/agents/knowledge/knowledge-resolver';
import {
    customAgentSlugClashMessage,
    KNOWLEDGE_MAIN_REVIEW_TARGET,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    ReviewAgentInput,
    ReviewAgentOutput,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';
import {
    dedupReviewWarnings,
    warningsFromError,
    type ReviewWarning,
} from '@libs/code-review/infrastructure/agents/engine/review-warnings';

export interface OrchestratorInput extends ReviewAgentInput {
    reviewOptions: ReviewOptions;
    kodyRules?: Partial<IKodyRule>[];
    /** Team-defined agents (#2172), passed only when the org has the
     *  `custom-agents` feature. Each runs on the changed files its globs match. */
    customAgents?: CustomAgentConfig[];
    /** `@kody -v <slug>`: run only that custom agent, nothing else. */
    onlyCustomAgent?: string;
    /** Changed files the review's ignore paths set aside (deleted files
     *  excluded). Only a custom agent whose include globs name one
     *  explicitly reviews it; no other agent sees them. */
    ignoredChangedFiles?: ReviewAgentInput['changedFiles'];
    /** Skills and docs per target: `main-review` for the built-in category
     *  agents, a custom agent's id for that agent. Kody Rules takes none. */
    knowledgeByTarget?: ReadonlyMap<string, ResolvedKnowledge>;
}

/** Which custom agent a failure, cut-short run or unverified set belongs to. */
export interface OrchestratorCustomAgentRef {
    id: string;
}

export interface OrchestratorAgentFailure {
    agentName: string;
    category: string;
    error: Error;
    durationMs: number;
    customAgent?: OrchestratorCustomAgentRef;
}

/**
 * An agent that returned, but was cut short (out of steps, or its turn
 * truncated by the provider) rather than finishing its investigation. Not a failure (it may still have produced
 * findings) — but its silence is not evidence of clean code, so the pipeline
 * must not read it as one.
 */
export interface OrchestratorAgentIncomplete {
    agentName: string;
    category: string;
    finishReason: 'max-steps' | 'truncated';
    suggestionsFound: number;
    durationMs: number;
    customAgent?: OrchestratorCustomAgentRef;
}

/**
 * An agent whose findings could not all be verified: the verifier's model call
 * failed, so those findings were not published (#2171). Like a cut-short
 * agent, its review is not complete.
 */
export interface OrchestratorAgentUnverified {
    agentName: string;
    category: string;
    unverifiedCount: number;
    customAgent?: OrchestratorCustomAgentRef;
}

export interface OrchestratorOutput {
    suggestions: Partial<CodeSuggestion>[];
    agentResults: ReviewAgentOutput[];
    failures: OrchestratorAgentFailure[];
    /** Agents that ran to their budget ceiling instead of to completion. */
    incomplete: OrchestratorAgentIncomplete[];
    /** Agents that left findings unverified because the verify call failed. */
    unverified?: OrchestratorAgentUnverified[];
    /** One entry per custom agent selected for the review, run or not. */
    customAgentRuns?: CustomAgentRun[];
    totalDurationMs: number;
    /** Fidelity warnings collected across all per-agent fan-out, deduped
     *  by (kind, modelName, contextWindowTokens). Empty array when no
     *  adaptive strategy fired. */
    warnings: ReviewWarning[];
}

/**
 * Orchestrates the code review agents.
 *
 * - Checks which categories are enabled in reviewOptions
 * - Dispatches enabled agents in parallel
 * - Collects and deduplicates results
 */
@Injectable()
export class ReviewOrchestratorService {
    private readonly logger = createLogger(ReviewOrchestratorService.name);
    private static readonly FAST_MODE_MAX_STEPS: Record<string, number> = {
        'generalist': 4,
        'bug': 4,
        'security': 3,
        'performance': 3,
        'kody-rules': 4,
        'custom-agent': 4,
    };
    private static readonly NORMAL_MODE_MAX_STEPS: Record<string, number> = {
        'generalist': 20,
        'bug': 20,
        'security': 12,
        'performance': 12,
        'kody-rules': 20,
        'custom-agent': 20,
    };
    private static readonly DEEP_MODE_MAX_STEPS = 100;

    constructor(
        private readonly bugAgent: BugAgentProvider,
        private readonly securityAgent: SecurityAgentProvider,
        private readonly performanceAgent: PerformanceAgentProvider,
        private readonly generalistAgent: GeneralistAgentProvider,
        @Optional()
        private readonly kodyRulesAgent?: KodyRulesAgentProvider,
        @Optional()
        private readonly customAgentFactory?: CustomAgentProviderFactory,
    ) {}

    async execute(input: OrchestratorInput): Promise<OrchestratorOutput> {
        const startTime = Date.now();
        const {
            reviewOptions,
            kodyRules,
            customAgents,
            onlyCustomAgent,
            knowledgeByTarget,
            ignoredChangedFiles,
            ...agentInput
        } = input;
        const mainKnowledge = knowledgeByTarget?.get(
            KNOWLEDGE_MAIN_REVIEW_TARGET,
        );

        // Determine which agents to run based on review options
        const agentTasks: Array<{
            name: string;
            provider: { execute: (input: any) => Promise<ReviewAgentOutput> };
            /** Step-budget key; `name` when unset. */
            budgetKey?: string;
            /** The files this agent reviews, when narrower than the PR. */
            changedFiles?: ReviewAgentInput['changedFiles'];
            customAgent?: OrchestratorCustomAgentRef;
            /** Skills and docs linked to this agent's target. */
            knowledge?: ResolvedKnowledge;
        }> = [];
        const customAgentRuns: CustomAgentRun[] = [];
        // `@kody -v <slug>` runs that agent alone: the built-in agents
        // already reviewed this PR, the command asks for one more opinion.
        // A PR whose changed files are all ignored has nothing for them
        // either: only the custom agents naming some of those files review it.
        const onlyIgnoredFiles =
            !agentInput.changedFiles?.length && !!ignoredChangedFiles?.length;
        const builtInAgents = !onlyCustomAgent && !onlyIgnoredFiles;

        const enabledCategories = [
            reviewOptions.bug !== false && 'bug',
            reviewOptions.security !== false && 'security',
            reviewOptions.performance !== false && 'performance',
        ].filter(Boolean) as Array<'bug' | 'security' | 'performance'>;

        if (!builtInAgents) {
            // Only the requested custom agent runs (below).
        } else if (agentInput.reviewMode === 'deep') {
            if (enabledCategories.includes('bug')) {
                agentTasks.push({
                    name: 'bug',
                    provider: this.bugAgent,
                    knowledge: mainKnowledge,
                });
            }
            if (enabledCategories.includes('security')) {
                agentTasks.push({
                    name: 'security',
                    provider: this.securityAgent,
                    knowledge: mainKnowledge,
                });
            }
            if (enabledCategories.includes('performance')) {
                agentTasks.push({
                    name: 'performance',
                    provider: this.performanceAgent,
                    knowledge: mainKnowledge,
                });
            }
        } else if (enabledCategories.length > 0) {
            agentTasks.push({
                name: 'generalist',
                provider: {
                    execute: (inp: ReviewAgentInput) =>
                        this.generalistAgent.execute({
                            ...inp,
                            requestedCategories: enabledCategories,
                        }),
                },
                knowledge: mainKnowledge,
            });
        }

        // Add Kody Rules agent if there are active standard rules
        if (
            builtInAgents &&
            this.kodyRulesAgent &&
            kodyRules &&
            kodyRules.length > 0
        ) {
            agentTasks.push({
                name: 'kody-rules',
                provider: {
                    execute: (inp: ReviewAgentInput) =>
                        this.kodyRulesAgent!.execute({
                            ...inp,
                            kodyRules,
                        }),
                },
            });
        }

        // Custom agents run next to the built-in ones, each on the files its
        // globs match. One whose globs match nothing is recorded, not run.
        if (this.customAgentFactory) {
            // A save refuses two agents sharing a slug; one saved before that
            // check still loads, and only the first of the two runs.
            const slugClash = customAgentSlugClashMessage(customAgents ?? []);
            if (slugClash) {
                this.logger.warn({
                    message: `Custom agent slug clash, running the first only: ${slugClash}`,
                    context: ReviewOrchestratorService.name,
                    metadata: {
                        organizationId:
                            agentInput.organizationAndTeamData?.organizationId,
                        teamId: agentInput.organizationAndTeamData?.teamId,
                        repositoryId: agentInput.repositoryId,
                        prNumber: input.prNumber,
                    },
                });
            }
            for (const agent of selectCustomAgents(
                customAgents,
                onlyCustomAgent,
            )) {
                const slug = customAgentSlug(agent.name);
                const files = [
                    ...filesInAgentScope(agent, agentInput.changedFiles ?? []),
                    ...ignoredFilesInAgentScope(
                        agent,
                        ignoredChangedFiles ?? [],
                    ),
                ];
                const run: CustomAgentRun = {
                    id: agent.id,
                    name: agent.name,
                    slug,
                    status: 'ran',
                    droppedByVerify: 0,
                };
                customAgentRuns.push(run);
                if (files.length === 0) {
                    run.status = 'no-matching-files';
                    continue;
                }
                const provider = this.customAgentFactory.create(agent);
                agentTasks.push({
                    name: `custom-agent:${slug}`,
                    budgetKey: 'custom-agent',
                    provider,
                    changedFiles: files,
                    customAgent: { id: agent.id },
                    knowledge: knowledgeByTarget?.get(agent.id),
                });
            }
        }

        if (agentTasks.length === 0) {
            this.logger.log({
                message: `[AGENT] No agent categories enabled, skipping agent review for PR#${agentInput.prNumber}`,
                context: ReviewOrchestratorService.name,
            });
            return {
                suggestions: [],
                agentResults: [],
                failures: [],
                incomplete: [],
                unverified: [],
                customAgentRuns,
                totalDurationMs: Date.now() - startTime,
                warnings: [],
            };
        }

        this.logger.log({
            message: `[AGENT] Dispatching ${agentTasks.length} agents in parallel for PR#${agentInput.prNumber}: ${agentTasks.map((t) => t.name).join(', ')}`,
            context: ReviewOrchestratorService.name,
            metadata: {
                prNumber: agentInput.prNumber,
                agents: agentTasks.map((t) => t.name),
                filesCount: agentInput.changedFiles.length,
            },
        });

        // Strip file bodies from changedFiles before sending to agents.
        // Agents access full source on demand via readFile in the sandbox.
        const agentInputWithoutContent: ReviewAgentInput = {
            ...agentInput,
            changedFiles: agentInput.changedFiles.map(
                ({ content: _content, fileContent: _fileContent, ...rest }) =>
                    rest as any,
            ),
        };

        const runAgent = async (task: (typeof agentTasks)[0]) => {
            const agentStart = Date.now();
            try {
                const changedFiles =
                    task.changedFiles?.map(
                        ({
                            content: _content,
                            fileContent: _fileContent,
                            ...rest
                        }) => rest as any,
                    ) ?? agentInputWithoutContent.changedFiles;
                // A scoped agent sees only its files: the PR-wide call graph
                // and analyzer findings would send it after the rest.
                const scopedPaths = task.changedFiles?.map((f) => f.filename);
                const scopedContext = scopedPaths
                    ? {
                          callGraph: scopeCallGraph(
                              agentInputWithoutContent.callGraph,
                              scopedPaths,
                          ),
                          analyzerFindings:
                              agentInputWithoutContent.analyzerFindings?.filter(
                                  (f) => scopedPaths.includes(f.path),
                              ),
                      }
                    : {};
                // A custom agent weighs only the decisions on its own
                // findings; the built-in agents' verdicts read to it as
                // "already decided" and it reported nothing.
                const ownDecisions = task.customAgent
                    ? {
                          previousDecisions:
                              agentInputWithoutContent.previousDecisions?.filter(
                                  (d) =>
                                      d.customAgentId === task.customAgent!.id,
                              ),
                      }
                    : {};
                return await task.provider.execute({
                    ...agentInputWithoutContent,
                    changedFiles,
                    ...scopedContext,
                    ...ownDecisions,
                    knowledge: task.knowledge,
                    maxSteps: this.getMaxStepsForAgent(
                        task.budgetKey ?? task.name,
                        agentInput.reviewMode,
                        changedFiles.length,
                    ),
                });
            } catch (error) {
                // Terminal BYOK (suspended key / no credit) → warn, not error:
                // the user's provider config, not a Kodus fault. A real fault
                // stays error. (Consistent with the sub-services.)
                this.logger[llmErrorLogLevel(error)]({
                    message: `[AGENT] ${task.name} agent failed for PR#${agentInput.prNumber}`,
                    context: ReviewOrchestratorService.name,
                    error,
                    metadata: {
                        agent: task.name,
                        prNumber: agentInput.prNumber,
                        organizationAndTeamData:
                            agentInput.organizationAndTeamData,
                        durationMs: Date.now() - agentStart,
                    },
                });
                throw error;
            }
        };

        const results = await Promise.allSettled(
            agentTasks.map((task) => runAgent(task)),
        );

        const agentResults: ReviewAgentOutput[] = [];
        const rejectedWarnings: ReviewWarning[] = [];
        const allSuggestions: Partial<CodeSuggestion>[] = [];
        const failures: OrchestratorAgentFailure[] = [];
        const incomplete: OrchestratorAgentIncomplete[] = [];
        const unverified: OrchestratorAgentUnverified[] = [];

        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            const agentName = agentTasks[i].name;
            const customAgent = agentTasks[i].customAgent;
            const customRun = customAgent
                ? customAgentRuns.find((r) => r.id === customAgent.id)
                : undefined;

            if (result.status === 'fulfilled') {
                agentResults.push(result.value);
                allSuggestions.push(...result.value.suggestions);

                if (customRun) {
                    customRun.droppedByVerify =
                        (result.value.discardedByVerify?.length ?? 0) +
                        (result.value.discardedByVerifyError?.length ?? 0);
                    if (result.value.hitHardLimit) {
                        customRun.status = 'incomplete';
                    }
                }

                if (result.value.hitHardLimit) {
                    incomplete.push({
                        ...(customAgent && { customAgent }),
                        agentName,
                        category: result.value.agentCategory ?? agentName,
                        finishReason:
                            result.value.finishReason === 'truncated'
                                ? 'truncated'
                                : 'max-steps',
                        suggestionsFound: result.value.suggestions.length,
                        durationMs: result.value.durationMs,
                    });

                    this.logger.warn({
                        message: `[AGENT] ${agentName} stopped at its ${result.value.finishReason} limit for PR#${agentInput.prNumber} with ${result.value.suggestions.length} suggestions — review is incomplete`,
                        context: ReviewOrchestratorService.name,
                        metadata: {
                            agent: agentName,
                            prNumber: agentInput.prNumber,
                            finishReason: result.value.finishReason,
                            durationMs: result.value.durationMs,
                        },
                    });
                }

                const unverifiedCount =
                    result.value.discardedByVerifyError?.length ?? 0;
                if (unverifiedCount > 0) {
                    unverified.push({
                        ...(customAgent && { customAgent }),
                        agentName,
                        category: result.value.agentCategory ?? agentName,
                        unverifiedCount,
                    });
                }

                this.logger.log({
                    message: `[AGENT] ${agentName} returned ${result.value.suggestions.length} suggestions in ${result.value.durationMs}ms`,
                    context: ReviewOrchestratorService.name,
                });
            } else {
                const err =
                    result.reason instanceof Error
                        ? result.reason
                        : new Error(String(result.reason));
                failures.push({
                    agentName,
                    category: agentName,
                    error: err,
                    durationMs: 0,
                    ...(customAgent && { customAgent }),
                });
                if (customRun) {
                    customRun.status = 'failed';
                }

                // A thrown agent is dropped by allSettled, and with it anything
                // it wanted the PR to say. Harvest the warnings it carried so a
                // degrade that escalates still reports WHAT degraded.
                rejectedWarnings.push(...warningsFromError(err));

                this.logger[llmErrorLogLevel(err)]({
                    message: `[AGENT] ${agentName} failed: ${err.message || 'Unknown error'}`,
                    context: ReviewOrchestratorService.name,
                    error: err,
                    metadata: {
                        agent: agentName,
                        prNumber: agentInput.prNumber,
                        organizationAndTeamData:
                            agentInput.organizationAndTeamData,
                    },
                });
            }
        }

        const totalDurationMs = Date.now() - startTime;

        this.logger.log({
            message: `[AGENT] Orchestrator completed for PR#${agentInput.prNumber}: ${allSuggestions.length} suggestions, ${failures.length} failures, ${incomplete.length} incomplete in ${totalDurationMs}ms`,
            context: ReviewOrchestratorService.name,
            metadata: {
                prNumber: agentInput.prNumber,
                totalSuggestions: allSuggestions.length,
                totalDurationMs,
                failureCount: failures.length,
                failedAgents: failures.map((f) => f.agentName),
                incompleteAgents: incomplete.map((a) => a.agentName),
            },
        });

        const warnings = dedupReviewWarnings(
            agentResults
                .flatMap((r) => r.warnings ?? [])
                .concat(rejectedWarnings),
        );

        return {
            suggestions: allSuggestions,
            agentResults,
            failures,
            incomplete,
            unverified,
            customAgentRuns,
            totalDurationMs,
            warnings,
        };
    }

    private getMaxStepsForAgent(
        agentName: string,
        reviewMode?: 'fast' | 'normal' | 'deep',
        changedFilesCount = 0,
    ): number {
        if (reviewMode === 'deep') {
            return ReviewOrchestratorService.DEEP_MODE_MAX_STEPS;
        }

        if (reviewMode === 'fast') {
            return (
                ReviewOrchestratorService.FAST_MODE_MAX_STEPS[agentName] ?? 4
            );
        }

        const base =
            ReviewOrchestratorService.NORMAL_MODE_MAX_STEPS[agentName] ?? 20;

        // Adaptive step budget by PR size. A fixed budget spreads thin over
        // large PRs (measured: recall on >500-line PRs drops to ~35% vs ~46%
        // for medium), so the agent can't open enough files to investigate.
        // Grant extra steps beyond a baseline file count, capped so cost/time
        // stays bounded. Investigation-only lever: no prompt change, no new
        // candidates generated — the same agent just gets to look deeper.
        const BASELINE_FILES = 8; // ~median changed-files for this workload
        const STEPS_PER_EXTRA_FILE = 0.5;
        const ADAPTIVE_CAP = ReviewOrchestratorService.DEEP_MODE_MAX_STEPS; // 100

        if (changedFilesCount <= BASELINE_FILES) {
            return base;
        }

        const extra = Math.round(
            (changedFilesCount - BASELINE_FILES) * STEPS_PER_EXTRA_FILE,
        );
        return Math.min(base + extra, ADAPTIVE_CAP);
    }
}
