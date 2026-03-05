import { resolveCapabilityToolSelection } from '../skill-capabilities';

import { SkillCapabilityRuntimeConfig } from './skill-runtime.types';

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

    return {
        ...selection,
        getToolName: (capability: string) =>
            selection.toolByCapability[capability],
    };
}
