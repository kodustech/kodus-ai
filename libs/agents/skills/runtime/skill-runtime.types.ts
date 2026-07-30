import {
    SkillCapabilityDefinition,
    SkillContracts,
    SkillFetcherPolicy,
} from '../skill-loader.service';

/**
 * Thread identifier carried through the skills runtime for log/trace
 * correlation. Structurally compatible with the legacy flow engine's `Thread`
 * ({ id, metadata }) but typed locally so the skills layer carries no
 * flow-engine dependency (the agent loop runs on the harness now). This is
 * the single canonical definition — other skill files import it from here.
 */
export interface AgentThread {
    id?: unknown;
    metadata?: Record<string, unknown>;
}

export interface ToolExecutionResponse {
    result?: unknown;
}

export interface AgentCallOptions {
    thread?: AgentThread;
    userContext?: {
        organizationAndTeamData?: {
            organizationId: string;
            teamId: string;
        };
    };
}

export interface ToolCaller {
    callTool(
        toolName: string,
        args: Record<string, unknown>,
    ): Promise<ToolExecutionResponse>;
    callAgent?(
        agentName: string,
        prompt: string,
        options?: AgentCallOptions,
    ): Promise<ToolExecutionResponse>;
    getRegisteredTools(): Array<{ name?: string }>;
    getToolsForLLM?(): Array<{ name?: string; parameters?: unknown }>;
}

export interface SkillCapabilityRuntimeConfig {
    capabilities: string[];
    allowedTools: string[];
    capabilityToolMap?: Record<string, string[]>;
    capabilityDefinitions?: Record<string, SkillCapabilityDefinition>;
    fetcherPolicy: Required<SkillFetcherPolicy>;
    /** Primary external provider (first non-kodusmcp connection). */
    providerType: string;
    /** All external provider types available for this team (e.g. ['provider-a', 'provider-b']). */
    allProviderTypes?: string[];
    contracts?: SkillContracts;
}

export interface SkillFetcherRuntime {
    toolCaller: ToolCaller;
    capabilityRuntime: SkillCapabilityRuntimeConfig;
}

export type CapabilityExecutionMode = 'deterministic' | 'agentic';
export type CapabilityExecutionStatus = 'success' | 'failed' | 'skipped';

export interface CapabilityExecutionTrace {
    organizationId: string;
    teamId: string;
    skillName: string;
    capability: string;
    provider: string;
    mode: CapabilityExecutionMode;
    status: CapabilityExecutionStatus;
    toolName?: string;
    reason?: string;
    latencyMs: number;
    occurredAt: string;
}

export interface CapabilityStrategyScope {
    organizationId: string;
    teamId: string;
    skillName: string;
    capability: string;
    provider: string;
}

export interface CapabilityExecutionHooks<TContext = unknown> {
    resolvePreferredTool?: (
        scope: CapabilityStrategyScope,
        candidateTools: string[],
    ) => Promise<string | undefined>;
    getCachedTaskContextTools?: (
        scope: CapabilityStrategyScope,
    ) => Promise<string[]>;
    saveCachedTaskContextTools?: (
        scope: CapabilityStrategyScope,
        tools: string[],
    ) => Promise<void>;
    getSeedTaskContextTools?: (
        providerType: string,
        capability: string,
    ) => Promise<string[]>;
    resolveTaskContextMode?: (
        ctx: TContext,
        providerType: string,
    ) => 'cache_first' | 'agent_first';
    recordExecution?: (trace: CapabilityExecutionTrace) => Promise<void>;
}
