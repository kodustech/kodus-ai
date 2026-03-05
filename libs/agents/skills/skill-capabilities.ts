import { SkillCapabilityDefinition } from './skill-loader.service';

/**
 * Capability catalog for skill orchestration.
 *
 * Skills declare abstract capabilities while runtime resolves each one by
 * strategy:
 * - fixed_tools: capability maps to a known deterministic tool set
 * - provider_dynamic: capability is resolved by provider/runtime strategy
 */
export type CapabilityResolutionMode = 'fixed_tools' | 'provider_dynamic';

export interface CapabilityResolutionDefinition {
    mode: CapabilityResolutionMode;
    tools?: string[];
}

export const SKILL_CAPABILITY_REGISTRY: Record<
    string,
    CapabilityResolutionDefinition
> = {
    'pr.diff.read': {
        mode: 'fixed_tools',
        tools: ['KODUS_GET_PULL_REQUEST_DIFF'],
    },
    'pr.metadata.read': {
        mode: 'fixed_tools',
        tools: ['KODUS_GET_PULL_REQUEST'],
    },
    // External providers vary by MCP integration and are resolved at runtime.
    'task.context.read': {
        mode: 'provider_dynamic',
    },
};

function resolveCapabilityDefinition(params: {
    capability: string;
    capabilityToolMap?: Record<string, string[]>;
    capabilityDefinitions?: Record<string, SkillCapabilityDefinition>;
}): CapabilityResolutionDefinition | undefined {
    const customDefinition = params.capabilityDefinitions?.[params.capability];
    if (customDefinition) {
        if (customDefinition.mode === 'provider_dynamic') {
            return { mode: 'provider_dynamic' };
        }

        const customTools = customDefinition.tools ?? [];
        if (customTools.length) {
            return {
                mode: 'fixed_tools',
                tools: customTools,
            };
        }
    }

    const builtin = SKILL_CAPABILITY_REGISTRY[params.capability];
    if (builtin) {
        return builtin;
    }

    const dynamicTools = params.capabilityToolMap?.[params.capability];
    if (!dynamicTools?.length) {
        return undefined;
    }

    return {
        mode: 'fixed_tools',
        tools: dynamicTools,
    };
}

export function resolveCapabilityTools(
    capabilities?: string[],
    capabilityToolMap?: Record<string, string[]>,
    capabilityDefinitions?: Record<string, SkillCapabilityDefinition>,
): {
    tools: string[];
    unknownCapabilities: string[];
} {
    if (!capabilities?.length) {
        return { tools: [], unknownCapabilities: [] };
    }

    const resolvedTools = new Set<string>();
    const unknownCapabilities: string[] = [];

    for (const capability of capabilities) {
        const definition = resolveCapabilityDefinition({
            capability,
            capabilityToolMap,
            capabilityDefinitions,
        });
        if (!definition) {
            unknownCapabilities.push(capability);
            continue;
        }

        if (definition.mode === 'fixed_tools') {
            for (const tool of definition.tools ?? []) {
                resolvedTools.add(tool);
            }
        }
    }

    return {
        tools: [...resolvedTools],
        unknownCapabilities,
    };
}

export type CapabilityToolMode = 'any' | 'all';

export interface CapabilityToolSelectionParams {
    capabilities?: string[];
    allowedTools?: string[];
    capabilityToolMap?: Record<string, string[]>;
    capabilityDefinitions?: Record<string, SkillCapabilityDefinition>;
    registeredTools?: string[];
    toolMode?: CapabilityToolMode;
}

export interface CapabilityToolSelectionResult {
    toolByCapability: Record<string, string | undefined>;
    missingCapabilities: string[];
    unknownCapabilities: string[];
    hasRequiredTools: boolean;
}

/**
 * Resolves concrete MCP tools for each declared capability based on:
 * - capability → tool catalog
 * - SKILL.md allowed-tools
 * - currently registered tools in the orchestration
 * - fetcher policy (any/all)
 */
export function resolveCapabilityToolSelection(
    params: CapabilityToolSelectionParams,
): CapabilityToolSelectionResult {
    const capabilities = params.capabilities ?? [];
    const allowedToolsSet = new Set(params.allowedTools ?? []);
    const hasAllowedToolsFilter = allowedToolsSet.size > 0;
    const registeredToolsSet = new Set(params.registeredTools ?? []);
    const toolMode = params.toolMode ?? 'any';

    const toolByCapability: Record<string, string | undefined> = {};
    const missingCapabilities: string[] = [];
    const unknownCapabilities: string[] = [];
    const toolBackedCapabilities: string[] = [];

    for (const capability of capabilities) {
        const definition = resolveCapabilityDefinition({
            capability,
            capabilityToolMap: params.capabilityToolMap,
            capabilityDefinitions: params.capabilityDefinitions,
        });
        if (!definition) {
            unknownCapabilities.push(capability);
            toolByCapability[capability] = undefined;
            continue;
        }

        if (definition.mode !== 'fixed_tools') {
            toolByCapability[capability] = undefined;
            continue;
        }

        const mappedTools = definition.tools ?? [];
        if (!mappedTools.length) {
            toolByCapability[capability] = undefined;
            continue;
        }

        toolBackedCapabilities.push(capability);

        const candidates = hasAllowedToolsFilter
            ? mappedTools.filter((tool) => allowedToolsSet.has(tool))
            : mappedTools;

        const selectedTool = candidates.find((tool) =>
            registeredToolsSet.has(tool),
        );

        toolByCapability[capability] = selectedTool;
        if (!selectedTool) {
            missingCapabilities.push(capability);
        }
    }

    let hasRequiredTools = true;
    if (toolBackedCapabilities.length > 0) {
        if (toolMode === 'all') {
            hasRequiredTools = missingCapabilities.length === 0;
        } else {
            hasRequiredTools = toolBackedCapabilities.some(
                (capability) => toolByCapability[capability] !== undefined,
            );
        }
    }

    return {
        toolByCapability,
        missingCapabilities,
        unknownCapabilities,
        hasRequiredTools,
    };
}
