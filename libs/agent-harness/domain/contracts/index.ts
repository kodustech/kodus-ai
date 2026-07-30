/**
 * agent-harness public contracts (L1 — domain-agnostic harness primitives).
 *
 * Nothing in this package may import from a domain lib (code-review,
 * business-rules, ...). Dependency rule: domains depend on agent-harness,
 * never the reverse.
 */
export type { JSONSchema } from './json-schema.contract';
export type {
    AgentTool,
    ToolContext,
    ToolResult,
    ToolRegistry,
} from './tool.contract';
export type {
    AgentMessage,
    AgentRole,
    ToolCallRecord,
    RunStep,
    RunState,
    RunStatus,
    TokenUsage,
    Artifact,
    TraceEvent,
} from './run-state.contract';
export type {
    AgentPolicy,
    StepView,
    StepDirectives,
} from './policy.contract';
export type {
    AgentSpec,
    AgentRunner,
    AgentRunInput,
    SubAgentFactory,
} from './agent.contract';
export type { ModelResolver } from './model.contract';
export type {
    ProgressLedger,
    ProgressSummary,
} from './progress.contract';
export type {
    Compressor,
    CompressionResult,
} from './compression.contract';
export type {
    ConversationStore,
    ConversationMessage,
    ConversationAppendMeta,
} from './conversation-store.contract';
