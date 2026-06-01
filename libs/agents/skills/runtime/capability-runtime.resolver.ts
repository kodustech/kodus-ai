import { createLogger } from '@kodus/flow';

import { resolveCapabilityToolSelection } from '../skill-capabilities';

import { SkillCapabilityRuntimeConfig } from './skill-runtime.types';

const logger = createLogger('CapabilityToolRuntime');

export interface CapabilityToolRuntime {
    toolByCapability: Record<string, string | undefined>;
    missingCapabilities: string[];
    unknownCapabilities: string[];
    hasRequiredTools: boolean;
    getToolName: (capability: string) => string | undefined;
}

export function createCapabilityToolRuntime(params: {
    config: SkillCapabilityRuntimeConfig;
    registeredTools: string[];
}): CapabilityToolRuntime {
    const selection = resolveCapabilityToolSelection({
        capabilities: params.config.capabilities,
        allowedTools: params.config.allowedTools,
        capabilityToolMap: params.config.capabilityToolMap,
        capabilityDefinitions: params.config.capabilityDefinitions,
        registeredTools: params.registeredTools,
        toolMode: params.config.fetcherPolicy.toolMode,
    });

    if (selection.missingCapabilities.length > 0) {
        logger.warn({
            message: 'Capability tool resolution has missing capabilities',
            context: 'createCapabilityToolRuntime',
            metadata: {
                missingCapabilities: selection.missingCapabilities,
                toolByCapability: selection.toolByCapability,
                registeredToolCount: params.registeredTools.length,
                registeredTools: params.registeredTools,
                allowedTools: params.config.allowedTools,
                capabilities: params.config.capabilities,
                toolMode: params.config.fetcherPolicy.toolMode,
            },
        });
    }

    return {
        ...selection,
        getToolName: (capability: string) =>
            selection.toolByCapability[capability],
    };
}
