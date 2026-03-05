import { CapabilityResourcePlanService } from './capability-resource-plan.service';
import { CapabilityStrategyService } from './capability-strategy.service';
import {
    CapabilityExecutionHooks,
    CapabilityExecutionTrace,
} from './skill-runtime.types';

type TaskContextResolutionMode = 'cache_first' | 'agent_first';

export interface BuildCapabilityHooksOptions<TContext = unknown> {
    strategyService?: CapabilityStrategyService;
    resourcePlanService?: CapabilityResourcePlanService;
    resolveTaskContextMode?: (
        ctx: TContext,
        providerType: string,
    ) => TaskContextResolutionMode;
    recordExecution?: (trace: CapabilityExecutionTrace) => Promise<void>;
}

export function buildCapabilityHooks<TContext = unknown>(
    options: BuildCapabilityHooksOptions<TContext>,
): CapabilityExecutionHooks<TContext> {
    return {
        resolvePreferredTool: (scope, candidateTools) =>
            options.strategyService?.getPreferredTool(scope, candidateTools) ??
            Promise.resolve(undefined),
        getCachedTaskContextTools: (scope) =>
            options.resourcePlanService?.getCachedTools(scope) ??
            Promise.resolve([]),
        saveCachedTaskContextTools: (scope, tools) =>
            options.resourcePlanService?.saveCachedTools(scope, tools) ??
            Promise.resolve(),
        getSeedTaskContextTools: (providerType, capability) =>
            Promise.resolve(
                options.resourcePlanService?.getSeedTools(
                    providerType,
                    capability,
                ) ?? [],
            ),
        resolveTaskContextMode:
            options.resolveTaskContextMode ??
            (() => {
                return 'cache_first';
            }),
        recordExecution:
            options.recordExecution ??
            ((trace) =>
                options.strategyService?.recordExecution(trace) ??
                Promise.resolve()),
    };
}
