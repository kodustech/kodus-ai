export type ReviewMode = 'fast' | 'normal' | 'deep';
export type ReviewAgentId =
    'generalist' | 'bug' | 'security' | 'performance' | 'kody-rules';

export interface ReviewAgentBudget {
    enabled: boolean;
    maxSteps: number;
}

export interface ReviewModePolicy {
    maxParallelAgents: number;
    agents: Record<ReviewAgentId, ReviewAgentBudget>;
    adaptiveBudget: {
        baselineFiles: number;
        stepsPerExtraFile: number;
        maxSteps: number;
    };
}

export interface ReviewPolicy {
    version: '1';
    planner: {
        strategy: 'mode-compatible' | 'risk-based';
        specialistRiskThreshold: number;
        largeChangeFiles: number;
        largeChangeLines: number;
    };
    modes: Record<ReviewMode, ReviewModePolicy>;
}

export interface ReviewPolicyConfig {
    version?: string;
    planner?: Partial<ReviewPolicy['planner']>;
    modes?: Partial<
        Record<
            ReviewMode,
            Partial<Omit<ReviewModePolicy, 'agents' | 'adaptiveBudget'>> & {
                agents?: Partial<
                    Record<ReviewAgentId, Partial<ReviewAgentBudget>>
                >;
                adaptiveBudget?: Partial<ReviewModePolicy['adaptiveBudget']>;
            }
        >
    >;
}

const agentBudgets = (
    generalist: number,
    bug: number,
    security: number,
    performance: number,
    kodyRules: number,
): Record<ReviewAgentId, ReviewAgentBudget> => ({
    'generalist': { enabled: true, maxSteps: generalist },
    'bug': { enabled: true, maxSteps: bug },
    'security': { enabled: true, maxSteps: security },
    'performance': { enabled: true, maxSteps: performance },
    'kody-rules': { enabled: true, maxSteps: kodyRules },
});

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
    version: '1',
    planner: {
        strategy: 'risk-based',
        specialistRiskThreshold: 3,
        largeChangeFiles: 20,
        largeChangeLines: 800,
    },
    modes: {
        fast: {
            maxParallelAgents: 2,
            agents: agentBudgets(4, 4, 3, 3, 4),
            adaptiveBudget: {
                baselineFiles: Number.MAX_SAFE_INTEGER,
                stepsPerExtraFile: 0,
                maxSteps: 4,
            },
        },
        normal: {
            maxParallelAgents: 3,
            agents: agentBudgets(20, 20, 12, 12, 20),
            adaptiveBudget: {
                baselineFiles: 8,
                stepsPerExtraFile: 0.5,
                maxSteps: 100,
            },
        },
        deep: {
            maxParallelAgents: 4,
            agents: agentBudgets(100, 100, 100, 100, 100),
            adaptiveBudget: {
                baselineFiles: Number.MAX_SAFE_INTEGER,
                stepsPerExtraFile: 0,
                maxSteps: 100,
            },
        },
    },
};

const positive = (value: unknown, fallback: number, minimum = 1): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= minimum
        ? value
        : fallback;

const positiveInteger = (
    value: unknown,
    fallback: number,
    minimum = 1,
): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
        ? value
        : fallback;

/** Resolves a validated immutable policy while preserving v1 defaults. */
export function resolveReviewPolicy(config?: ReviewPolicyConfig): ReviewPolicy {
    if (config?.version && config.version !== '1') {
        throw new Error(`Unsupported review policy version: ${config.version}`);
    }

    const planner = config?.planner ?? {};
    if (
        planner.strategy !== undefined &&
        planner.strategy !== 'mode-compatible' &&
        planner.strategy !== 'risk-based'
    ) {
        throw new Error(
            `Unsupported review planner strategy: ${String(planner.strategy)}`,
        );
    }
    const modes = {} as Record<ReviewMode, ReviewModePolicy>;

    for (const mode of ['fast', 'normal', 'deep'] as const) {
        const defaults = DEFAULT_REVIEW_POLICY.modes[mode];
        const override = config?.modes?.[mode];
        const agents = {} as Record<ReviewAgentId, ReviewAgentBudget>;

        for (const agentId of Object.keys(defaults.agents) as ReviewAgentId[]) {
            const agentOverride = override?.agents?.[agentId];
            agents[agentId] = {
                enabled:
                    agentOverride?.enabled ?? defaults.agents[agentId].enabled,
                maxSteps: positiveInteger(
                    agentOverride?.maxSteps,
                    defaults.agents[agentId].maxSteps,
                ),
            };
        }

        modes[mode] = {
            maxParallelAgents: positiveInteger(
                override?.maxParallelAgents,
                defaults.maxParallelAgents,
            ),
            agents,
            adaptiveBudget: {
                baselineFiles: positiveInteger(
                    override?.adaptiveBudget?.baselineFiles,
                    defaults.adaptiveBudget.baselineFiles,
                    0,
                ),
                stepsPerExtraFile: positive(
                    override?.adaptiveBudget?.stepsPerExtraFile,
                    defaults.adaptiveBudget.stepsPerExtraFile,
                    0,
                ),
                maxSteps: positiveInteger(
                    override?.adaptiveBudget?.maxSteps,
                    defaults.adaptiveBudget.maxSteps,
                ),
            },
        };
    }

    return {
        version: '1',
        planner: {
            strategy: planner.strategy ?? 'risk-based',
            specialistRiskThreshold: positive(
                planner.specialistRiskThreshold,
                DEFAULT_REVIEW_POLICY.planner.specialistRiskThreshold,
                0,
            ),
            largeChangeFiles: positiveInteger(
                planner.largeChangeFiles,
                DEFAULT_REVIEW_POLICY.planner.largeChangeFiles,
            ),
            largeChangeLines: positiveInteger(
                planner.largeChangeLines,
                DEFAULT_REVIEW_POLICY.planner.largeChangeLines,
            ),
        },
        modes,
    };
}
