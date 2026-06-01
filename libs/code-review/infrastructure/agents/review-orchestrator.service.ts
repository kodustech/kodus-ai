import { createLogger } from '@kodus/flow';
import { Injectable, Optional } from '@nestjs/common';

import {
    CodeSuggestion,
    ReviewOptions,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { BugAgentProvider } from './bug-agent.provider';
import { SecurityAgentProvider } from './security-agent.provider';
import { PerformanceAgentProvider } from './performance-agent.provider';
import { GeneralistAgentProvider } from './generalist-agent.provider';
import { KodyRulesAgentProvider } from './kody-rules-agent.provider';
import {
    ReviewAgentInput,
    ReviewAgentOutput,
} from './base-code-review-agent.provider';
import {
    dedupReviewWarnings,
    type ReviewWarning,
} from './llm/review-warnings';

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

export interface OrchestratorOutput {
    suggestions: Partial<CodeSuggestion>[];
    agentResults: ReviewAgentOutput[];
    failures: OrchestratorAgentFailure[];
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
    };
    private static readonly NORMAL_MODE_MAX_STEPS: Record<string, number> = {
        'generalist': 20,
        'bug': 20,
        'security': 12,
        'performance': 12,
        'kody-rules': 20,
    };
    private static readonly DEEP_MODE_MAX_STEPS = 100;

    constructor(
        private readonly bugAgent: BugAgentProvider,
        private readonly securityAgent: SecurityAgentProvider,
        private readonly performanceAgent: PerformanceAgentProvider,
        private readonly generalistAgent: GeneralistAgentProvider,
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
            reviewOptions.bug !== false && 'bug',
            reviewOptions.security !== false && 'security',
            reviewOptions.performance !== false && 'performance',
        ].filter(Boolean) as Array<'bug' | 'security' | 'performance'>;

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
                ({ content, fileContent, ...rest }) => rest as any,
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

        // Collect successful results AND failures. Before this change, rejected
        // agents were only logged — callers had no way to tell whether the
        // review ran end-to-end or silently lost an agent. Returning failures
        // lets AgentReviewStage decide critical vs partial downstream.
        const agentResults: ReviewAgentOutput[] = [];
        const allSuggestions: Partial<CodeSuggestion>[] = [];
        const failures: OrchestratorAgentFailure[] = [];

        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            const agentName = agentTasks[i].name;

            if (result.status === 'fulfilled') {
                agentResults.push(result.value);
                allSuggestions.push(...result.value.suggestions);
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

        // No deterministic dedup here — LLM dedup in AgentReviewStage handles it better.
        // Deterministic dedup by line overlap was too aggressive, removing findings from
        // different categories (bug vs security) that happened to be on the same lines.

        const totalDurationMs = Date.now() - startTime;

        this.logger.log({
            message: `[AGENT] Orchestrator completed for PR#${agentInput.prNumber}: ${allSuggestions.length} suggestions, ${failures.length} failures in ${totalDurationMs}ms`,
            context: ReviewOrchestratorService.name,
            metadata: {
                prNumber: agentInput.prNumber,
                totalSuggestions: allSuggestions.length,
                totalDurationMs,
                failureCount: failures.length,
                failedAgents: failures.map((f) => f.agentName),
            },
        });

        // Fold cross-agent warnings (same `kind` + model can fire on 4
        // agents in parallel) into a single user-facing list before
        // handing back to the stage.
        const warnings = dedupReviewWarnings(
            agentResults.flatMap((r) => r.warnings ?? []),
        );

        return {
            suggestions: allSuggestions,
            agentResults,
            failures,
            totalDurationMs,
            warnings,
        };
    }

    private getMaxStepsForAgent(
        agentName: string,
        reviewMode?: 'fast' | 'normal' | 'deep',
    ): number {
        if (reviewMode === 'deep') {
            return ReviewOrchestratorService.DEEP_MODE_MAX_STEPS;
        }

        if (reviewMode === 'fast') {
            return (
                ReviewOrchestratorService.FAST_MODE_MAX_STEPS[agentName] ?? 4
            );
        }

        return ReviewOrchestratorService.NORMAL_MODE_MAX_STEPS[agentName] ?? 20;
    }

    /**
     * Deduplicate suggestions from different agents that target the same
     * file + overlapping line range + same category. Only removes true
     * duplicates (same category, high line overlap). Keeps suggestions
     * from different categories even if they overlap in lines — a bug
     * and a security issue on the same line are different findings.
     */
    private deduplicateSuggestions(
        suggestions: Partial<CodeSuggestion>[],
    ): Partial<CodeSuggestion>[] {
        if (suggestions.length <= 1) return suggestions;

        const severityOrder: Record<string, number> = {
            critical: 4,
            high: 3,
            medium: 2,
            low: 1,
        };

        // Group by file
        const byFile = new Map<string, Partial<CodeSuggestion>[]>();
        for (const s of suggestions) {
            const file = s.relevantFile || '';
            if (!byFile.has(file)) byFile.set(file, []);
            byFile.get(file)!.push(s);
        }

        const result: Partial<CodeSuggestion>[] = [];

        for (const [, fileSuggestions] of byFile) {
            // Sort by severity descending so higher severity is kept
            fileSuggestions.sort(
                (a, b) =>
                    (severityOrder[b.severity || 'medium'] || 2) -
                    (severityOrder[a.severity || 'medium'] || 2),
            );

            const kept: Partial<CodeSuggestion>[] = [];

            for (const candidate of fileSuggestions) {
                const isDuplicate = kept.some(
                    (existing) =>
                        this.sameCategory(existing, candidate) &&
                        this.highLineOverlap(existing, candidate),
                );
                if (!isDuplicate) {
                    kept.push(candidate);
                }
            }

            result.push(...kept);
        }

        return result;
    }

    /**
     * Check if two suggestions are from the same category (bug, security, performance).
     * Different categories = different findings, even on the same lines.
     */
    private sameCategory(
        a: Partial<CodeSuggestion>,
        b: Partial<CodeSuggestion>,
    ): boolean {
        const catA = (a.label || '').toLowerCase();
        const catB = (b.label || '').toLowerCase();
        if (!catA || !catB) return true; // If no label, assume same to be safe
        return catA === catB;
    }

    /**
     * Check if two suggestions have >70% line overlap.
     * Small overlaps (e.g., adjacent functions) are not duplicates.
     */
    private highLineOverlap(
        a: Partial<CodeSuggestion>,
        b: Partial<CodeSuggestion>,
    ): boolean {
        const aStart = a.relevantLinesStart ?? 0;
        const aEnd = a.relevantLinesEnd ?? aStart;
        const bStart = b.relevantLinesStart ?? 0;
        const bEnd = b.relevantLinesEnd ?? bStart;

        if (aStart === 0 || bStart === 0) return false;

        // No overlap at all
        if (aStart > bEnd || bStart > aEnd) return false;

        // Calculate overlap percentage
        const overlapStart = Math.max(aStart, bStart);
        const overlapEnd = Math.min(aEnd, bEnd);
        const overlapSize = overlapEnd - overlapStart + 1;
        const smallerRange = Math.min(aEnd - aStart + 1, bEnd - bStart + 1);

        // Only deduplicate if >70% of the smaller range overlaps
        return overlapSize / smallerRange > 0.7;
    }
}
