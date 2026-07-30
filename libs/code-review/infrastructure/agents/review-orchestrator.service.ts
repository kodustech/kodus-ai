import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable, Optional } from '@nestjs/common';

import {
    CodeSuggestion,
    ReviewOptions,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { BugAgentProvider } from '@libs/code-review/infrastructure/agents/providers/bug-agent.provider';
import { SecurityAgentProvider } from '@libs/code-review/infrastructure/agents/providers/security-agent.provider';
import { PerformanceAgentProvider } from '@libs/code-review/infrastructure/agents/providers/performance-agent.provider';
import { GeneralistAgentProvider } from '@libs/code-review/infrastructure/agents/providers/generalist-agent.provider';
import { DUPLICATE_LOGIC_AGENT_TOKEN, ReviewAgentInput, ReviewAgentOutput } from './review-agent.contract';
import { BaseCodeReviewAgentProvider } from './providers/base-code-review-agent.provider';
import {
    dedupReviewWarnings,
    type ReviewWarning,
} from '@libs/code-review/infrastructure/agents/engine/review-warnings';

export interface OrchestratorInput extends ReviewAgentInput {
    reviewOptions: ReviewOptions;
    kodyRules?: Partial<IKodyRule>[];
}

export interface OrchestratorAgentFailure {
    agentName: string;
    category: string;
    error: Error;
    durationMs: number;
}

/**
 * An agent that returned, but was cut short by its time or step budget rather
 * than finishing its investigation. Not a failure (it may still have produced
 * findings) — but its silence is not evidence of clean code, so the pipeline
 * must not read it as one.
 */
export interface OrchestratorAgentIncomplete {
    agentName: string;
    category: string;
    finishReason: 'timeout' | 'max-steps';
    suggestionsFound: number;
    durationMs: number;
}

export interface OrchestratorOutput {
    suggestions: Partial<CodeSuggestion>[];
    agentResults: ReviewAgentOutput[];
    failures: OrchestratorAgentFailure[];
    /** Agents that ran to their budget ceiling instead of to completion. */
    incomplete: OrchestratorAgentIncomplete[];
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
        'duplicate_logic': 4,
        'kody-rules': 4,
    };
    private static readonly NORMAL_MODE_MAX_STEPS: Record<string, number> = {
        'generalist': 20,
        'bug': 20,
        'security': 12,
        'performance': 12,
        'duplicate_logic': 12,
        'kody-rules': 20,
    };
    private static readonly DEEP_MODE_MAX_STEPS = 100;

    constructor(
        private readonly bugAgent: BugAgentProvider,
        private readonly securityAgent: SecurityAgentProvider,
        private readonly performanceAgent: PerformanceAgentProvider,
        private readonly generalistAgent: GeneralistAgentProvider,
        @Inject(DUPLICATE_LOGIC_AGENT_TOKEN)
        private readonly duplicateLogicAgent: BaseCodeReviewAgentProvider,
        @Optional()
        private readonly kodyRulesAgent?: KodyRulesAgentProvider,
    ) {}

    async execute(input: OrchestratorInput): Promise<OrchestratorOutput> {
        const startTime = Date.now();
        const { reviewOptions, kodyRules, ...agentInput } = input;

        // Determine which agents to run based on review options
        const agentTasks: Array<{
            name: string;
            provider: { execute: (input: any) => Promise<ReviewAgentOutput> };
        }> = [];

        const enabledCategories = [
            reviewOptions.bug ? 'bug' : null,
            reviewOptions.security ? 'security' : null,
            reviewOptions.performance ? 'performance' : null,
            reviewOptions.duplicate_logic ? 'duplicate_logic' : null,
        ].filter(Boolean) as Array<'bug' | 'security' | 'performance' | 'duplicate_logic'>;

        if (agentInput.reviewMode === 'deep') {
            if (enabledCategories.includes('bug')) {
                agentTasks.push({
                    name: 'bug',
                    provider: this.bugAgent,
                });
            }
            if (enabledCategories.includes('security')) {
                agentTasks.push({
                    name: 'security',
                    provider: this.securityAgent,
                });
            }
            if (enabledCategories.includes('performance')) {
                agentTasks.push({
                    name: 'performance',
                    provider: this.performanceAgent,
                });
            }
            if (enabledCategories.includes('duplicate_logic')) {
                agentTasks.push({
                    name: 'duplicate_logic',
                    provider: this.duplicateLogicAgent,
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
            });
        }

        // Add Kody Rules agent if there are active standard rules
        if (this.kodyRulesAgent && kodyRules && kodyRules.length > 0) {
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
                return await task.provider.execute({
                    ...agentInputWithoutContent,
                    maxSteps: this.getMaxStepsForAgent(
                        task.name,
                        agentInput.reviewMode,
                        agentInput.changedFiles?.length ?? 0,
                    ),
                });
            } catch (error) {
                this.logger.error({
                    message: `[AGENT] ${task.name} agent failed for PR#${agentInput.prNumber}`,
                    context: ReviewOrchestratorService.name,
                    error,
                    metadata: {
                        agent: task.name,
                        prNumber: agentInput.prNumber,
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
        const allSuggestions: Partial<CodeSuggestion>[] = [];
        const failures: OrchestratorAgentFailure[] = [];
        const incomplete: OrchestratorAgentIncomplete[] = [];

        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            const agentName = agentTasks[i].name;

            if (result.status === 'fulfilled') {
                agentResults.push(result.value);
                allSuggestions.push(...result.value.suggestions);

                if (result.value.hitHardLimit) {
                    incomplete.push({
                        agentName,
                        category: result.value.agentCategory ?? agentName,
                        finishReason:
                            result.value.finishReason === 'timeout'
                                ? 'timeout'
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
                });

                this.logger.error({
                    message: `[AGENT] ${agentName} failed: ${err.message || 'Unknown error'}`,
                    context: ReviewOrchestratorService.name,
                    error: err,
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
            agentResults.flatMap((r) => r.warnings ?? []),
        );

        return {
            suggestions: allSuggestions,
            agentResults,
            failures,
            incomplete,
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
