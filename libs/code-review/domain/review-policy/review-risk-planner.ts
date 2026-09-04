import { Injectable } from '@nestjs/common';

import { ReviewAgentId, ReviewMode, ReviewPolicy } from './review-policy';

type CoreCategory = 'bug' | 'security' | 'performance';

export interface ReviewPlannerFile {
    filename: string;
    additions?: number;
    deletions?: number;
    changes?: number;
}

export interface ReviewAgentPlanItem {
    agentId: ReviewAgentId;
    categories: CoreCategory[];
    maxSteps: number;
    riskScore: number;
    reasons: string[];
}

export interface ReviewExecutionPlan {
    policyVersion: string;
    strategy: ReviewPolicy['planner']['strategy'];
    reviewMode: ReviewMode;
    risks: Record<CoreCategory, number>;
    totalChangedLines: number;
    agents: ReviewAgentPlanItem[];
}

export interface ReviewPlanningInput {
    reviewMode?: ReviewMode;
    reviewOptions: Partial<Record<CoreCategory, boolean>>;
    changedFiles: ReviewPlannerFile[];
    hasKodyRules: boolean;
    policy: ReviewPolicy;
}

const CATEGORY_ORDER: CoreCategory[] = ['security', 'performance', 'bug'];

@Injectable()
export class ReviewRiskPlanner {
    plan(input: ReviewPlanningInput): ReviewExecutionPlan {
        const reviewMode = input.reviewMode ?? 'normal';
        const modePolicy = input.policy.modes[reviewMode];
        const enabled = (['bug', 'security', 'performance'] as const).filter(
            (category) => input.reviewOptions[category] !== false,
        );
        const totalChangedLines = input.changedFiles.reduce(
            (sum, file) =>
                sum +
                (file.changes ?? (file.additions ?? 0) + (file.deletions ?? 0)),
            0,
        );
        const risks = this.scoreRisks(input.changedFiles, input.policy);
        const selected: ReviewAgentPlanItem[] = [];

        if (reviewMode === 'deep') {
            for (const category of enabled.slice(
                0,
                modePolicy.maxParallelAgents,
            )) {
                this.addSpecialist(
                    selected,
                    category,
                    risks[category],
                    ['deep-mode'],
                    reviewMode,
                    input,
                );
            }
        } else if (input.policy.planner.strategy === 'mode-compatible') {
            this.addGeneralist(selected, enabled, risks, reviewMode, input);
        } else {
            const specialistSlots = Math.max(
                0,
                modePolicy.maxParallelAgents - 1,
            );
            const specialistCategories = CATEGORY_ORDER.filter(
                (category) =>
                    enabled.includes(category) &&
                    risks[category] >=
                        input.policy.planner.specialistRiskThreshold &&
                    modePolicy.agents[category].enabled,
            )
                .sort(
                    (left, right) =>
                        risks[right] - risks[left] ||
                        CATEGORY_ORDER.indexOf(left) -
                            CATEGORY_ORDER.indexOf(right),
                )
                .slice(0, specialistSlots);

            for (const category of specialistCategories) {
                this.addSpecialist(
                    selected,
                    category,
                    risks[category],
                    this.reasonsFor(category, input.changedFiles),
                    reviewMode,
                    input,
                );
            }

            const specialistCategorySet = new Set(specialistCategories);
            const remaining = enabled.filter(
                (category) => !specialistCategorySet.has(category),
            );
            this.addGeneralist(selected, remaining, risks, reviewMode, input);
        }

        if (input.hasKodyRules && modePolicy.agents['kody-rules'].enabled) {
            selected.push({
                agentId: 'kody-rules',
                categories: [],
                maxSteps: this.maxSteps(
                    'kody-rules',
                    reviewMode,
                    input.changedFiles.length,
                    input.policy,
                ),
                riskScore: 0,
                reasons: ['active-kody-rules'],
            });
        }

        return {
            policyVersion: input.policy.version,
            strategy: input.policy.planner.strategy,
            reviewMode,
            risks,
            totalChangedLines,
            agents: selected,
        };
    }

    private addGeneralist(
        selected: ReviewAgentPlanItem[],
        categories: CoreCategory[],
        risks: Record<CoreCategory, number>,
        reviewMode: ReviewMode,
        input: ReviewPlanningInput,
    ): void {
        if (
            categories.length === 0 ||
            !input.policy.modes[reviewMode].agents.generalist.enabled
        ) {
            return;
        }
        selected.push({
            agentId: 'generalist',
            categories,
            maxSteps: this.maxSteps(
                'generalist',
                reviewMode,
                input.changedFiles.length,
                input.policy,
            ),
            riskScore: Math.max(
                ...categories.map((category) => risks[category]),
            ),
            reasons: ['general-coverage'],
        });
    }

    private addSpecialist(
        selected: ReviewAgentPlanItem[],
        category: CoreCategory,
        riskScore: number,
        reasons: string[],
        reviewMode: ReviewMode,
        input: ReviewPlanningInput,
    ): void {
        if (!input.policy.modes[reviewMode].agents[category].enabled) return;
        selected.push({
            agentId: category,
            categories: [category],
            maxSteps: this.maxSteps(
                category,
                reviewMode,
                input.changedFiles.length,
                input.policy,
            ),
            riskScore,
            reasons,
        });
    }

    private maxSteps(
        agentId: ReviewAgentId,
        reviewMode: ReviewMode,
        fileCount: number,
        policy: ReviewPolicy,
    ): number {
        const mode = policy.modes[reviewMode];
        const base = mode.agents[agentId].maxSteps;
        if (fileCount <= mode.adaptiveBudget.baselineFiles) return base;
        const extra = Math.round(
            (fileCount - mode.adaptiveBudget.baselineFiles) *
                mode.adaptiveBudget.stepsPerExtraFile,
        );
        return Math.min(base + extra, mode.adaptiveBudget.maxSteps);
    }

    private scoreRisks(
        files: ReviewPlannerFile[],
        policy: ReviewPolicy,
    ): Record<CoreCategory, number> {
        const joined = files
            .map((file) => file.filename.toLowerCase())
            .join('\n');
        const totalLines = files.reduce(
            (sum, file) =>
                sum +
                (file.changes ?? (file.additions ?? 0) + (file.deletions ?? 0)),
            0,
        );
        const large =
            files.length >= policy.planner.largeChangeFiles ||
            totalLines >= policy.planner.largeChangeLines;

        return {
            security:
                this.keywordScore(joined, [
                    'auth',
                    'permission',
                    'security',
                    'token',
                    'secret',
                    'crypto',
                    'payment',
                    'webhook',
                    'guard',
                    'middleware',
                ]) + (large ? 1 : 0),
            performance:
                this.keywordScore(joined, [
                    'database',
                    'repository',
                    'query',
                    'sql',
                    'cache',
                    'queue',
                    'worker',
                    'batch',
                    'stream',
                ]) + (large ? 1 : 0),
            bug:
                this.keywordScore(joined, [
                    'controller',
                    'service',
                    'handler',
                    'processor',
                    'workflow',
                    'migration',
                ]) + (large ? 2 : 0),
        };
    }

    private keywordScore(value: string, keywords: string[]): number {
        return keywords.reduce(
            (score, keyword) => score + (value.includes(keyword) ? 2 : 0),
            0,
        );
    }

    private reasonsFor(
        category: CoreCategory,
        files: ReviewPlannerFile[],
    ): string[] {
        const matching = files
            .map((file) => file.filename)
            .filter((filename) => {
                const lower = filename.toLowerCase();
                const terms =
                    category === 'security'
                        ? ['auth', 'permission', 'token', 'webhook', 'guard']
                        : category === 'performance'
                          ? ['database', 'query', 'cache', 'queue', 'worker']
                          : ['controller', 'service', 'handler', 'workflow'];
                return terms.some((term) => lower.includes(term));
            })
            .slice(0, 3);
        return matching.length > 0
            ? matching.map((filename) => `risk-path:${filename}`)
            : ['change-size-risk'];
    }
}
