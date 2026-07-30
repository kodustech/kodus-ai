import {
    GenAISpanAttributes,
    SpanOptions,
    GEN_AI,
    AGENT,
    TOOL,
} from './types';

/**
 * Helper functions for OpenTelemetry Semantic Conventions
 * Based on: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

// Gen AI System Names (standardized)
export const GEN_AI_SYSTEM = {
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic',
    GOOGLE: 'google',
    GROQ: 'groq',
    TOGETHER: 'together',
    REPLICATE: 'replicate',
    HUGGINGFACE: 'huggingface',
} as const;

// Gen AI Operation Names
export const GEN_AI_OPERATION = {
    CHAT: 'chat',
    COMPLETION: 'text_completion',
    EMBEDDING: 'embedding',
    IMAGE_GENERATION: 'image_generation',
    AUDIO_TRANSCRIPTION: 'audio_transcription',
    AUDIO_SYNTHESIS: 'audio_synthesis',
} as const;

// Agent Types
export const AGENT_TYPE = {
    SUPERVISOR: 'supervisor',
    WORKER: 'worker',
    SPECIALIST: 'specialist',
    COORDINATOR: 'coordinator',
} as const;

// Tool Types
export const TOOL_TYPE = {
    API_CALL: 'api_call',
    DATABASE_QUERY: 'database_query',
    FILE_OPERATION: 'file_operation',
    COMPUTATION: 'computation',
    EXTERNAL_SERVICE: 'external_service',
    CUSTOM: 'custom',
} as const;

/**
 * Create standardized LLM call span attributes
 */
export function createLLMSpanAttributes(options: {
    system: string;
    model: string;
    operation?: string;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stopSequences?: string[];
}): GenAISpanAttributes {
    return {
        [GEN_AI.SYSTEM]: options.system,
        [GEN_AI.REQUEST_MODEL]: options.model,
        [GEN_AI.OPERATION_NAME]: options.operation || GEN_AI_OPERATION.CHAT,
        [GEN_AI.REQUEST_TEMPERATURE]: options.temperature,
        [GEN_AI.REQUEST_MAX_TOKENS]: options.maxTokens,
        [GEN_AI.REQUEST_TOP_P]: options.topP,
        [GEN_AI.REQUEST_FREQUENCY_PENALTY]: options.frequencyPenalty,
        [GEN_AI.REQUEST_PRESENCE_PENALTY]: options.presencePenalty,
        [GEN_AI.REQUEST_STOP_SEQUENCES]: options.stopSequences,
    };
}

/**
 * Create standardized agent execution span attributes
 */
export function createAgentSpanAttributes(options: {
    agentName: string;
    agentVersion?: string;
    agentType?: string;
    executionId: string;
    conversationId?: string;
    userId?: string;
    tenantId?: string;
    correlationId?: string;
    input?: string;
    inputTokens?: number;
}): GenAISpanAttributes {
    return {
        [AGENT.NAME]: options.agentName,
        [AGENT.VERSION]: options.agentVersion,
        [AGENT.TYPE]: options.agentType as any,
        [AGENT.EXECUTION_ID]: options.executionId,
        [AGENT.CONVERSATION_ID]: options.conversationId,
        [AGENT.USER_ID]: options.userId,
        [AGENT.TENANT_ID]: options.tenantId,
        [AGENT.CORRELATION_ID]: options.correlationId,
        [GEN_AI.USAGE_INPUT_TOKENS]: options.inputTokens,
    };
}

/**
 * Create standardized tool execution span attributes
 */
export function createToolSpanAttributes(options: {
    toolName: string;
    toolType?: string;
    executionId: string;
    parameters?: Record<string, unknown>;
    inputTokens?: number;
    correlationId?: string;
}): GenAISpanAttributes {
    return {
        [TOOL.NAME]: options.toolName,
        [TOOL.TYPE]: options.toolType,
        [TOOL.EXECUTION_ID]: options.executionId,
        [TOOL.PARAMETERS]: options.parameters,
        [GEN_AI.USAGE_INPUT_TOKENS]: options.inputTokens,
        [TOOL.CORRELATION_ID]: options.correlationId,
    };
}

/**
 * Update LLM span with response data
 */
export function updateLLMSpanWithResponse(
    attributes: GenAISpanAttributes,
    response: {
        finishReasons?: string[];
        responseId?: string;
        model?: string;
        usage?: {
            inputTokens: number;
            outputTokens: number;
            totalTokens: number;
            cost?: number;
        };
    },
): GenAISpanAttributes {
    return {
        ...attributes,
        [GEN_AI.RESPONSE_FINISH_REASONS]: response.finishReasons,
        [GEN_AI.RESPONSE_ID]: response.responseId,
        [GEN_AI.RESPONSE_MODEL]: response.model,
        [GEN_AI.USAGE_INPUT_TOKENS]: response.usage?.inputTokens,
        [GEN_AI.USAGE_OUTPUT_TOKENS]: response.usage?.outputTokens,
        [GEN_AI.USAGE_TOTAL_TOKENS]: response.usage?.totalTokens,
        [GEN_AI.USAGE_COST]: response.usage?.cost,
    };
}

/**
 * Update tool span with result data
 */
export function updateToolSpanWithResult(
    attributes: GenAISpanAttributes,
    result: {
        outputTokens?: number;
        resultSize?: number;
        success?: boolean;
        errorType?: string;
    },
): GenAISpanAttributes {
    return {
        ...attributes,
        [GEN_AI.USAGE_OUTPUT_TOKENS]: result.outputTokens,
        [TOOL.RESULT_SIZE]: result.resultSize,
        ...(result.errorType && { [TOOL.ERROR_TYPE]: result.errorType }),
    };
}

/**
 * Create span options with semantic conventions
 */
export function createSemanticSpanOptions(
    _name: string,
    attributes: GenAISpanAttributes,
    options: Omit<SpanOptions, 'attributes'> = {},
): SpanOptions {
    return {
        ...options,
        attributes: attributes as Record<string, string | number | boolean>,
    };
}

/**
 * Standardized span names following OpenTelemetry conventions
 */
export const SPAN_NAMES = {
    // Agent operations
    AGENT_EXECUTE: 'agent.execute',
    AGENT_THINK: 'agent.think',
    AGENT_PLAN: 'agent.plan',
    AGENT_OBSERVE: 'agent.observe',
    AGENT_ACT: 'agent.act',
    AGENT_SYNTHESIZE: 'agent.synthesize',

    // LLM operations
    LLM_CHAT: 'gen_ai.chat',
    LLM_COMPLETION: 'gen_ai.text_completion',
    LLM_EMBEDDING: 'gen_ai.embedding',
    LLM_IMAGE_GENERATION: 'gen_ai.image_generation',

    // Tool operations
    TOOL_EXECUTE: 'tool.execute',
    TOOL_API_CALL: 'tool.api_call',
    TOOL_DATABASE_QUERY: 'tool.database_query',
    TOOL_FILE_OPERATION: 'tool.file_operation',

    // Workflow operations
    WORKFLOW_EXECUTE: 'workflow.execute',
    WORKFLOW_STEP: 'workflow.step',

    // System operations
    SYSTEM_MEMORY_ACCESS: 'system.memory_access',
    SYSTEM_VECTOR_SEARCH: 'system.vector_search',
    SYSTEM_CACHE_OPERATION: 'system.cache_operation',
} as const;

/**
 * Helper to create agent execution span with full semantic conventions
 */
export function createAgentExecutionSpan(
    agentName: string,
    executionId: string,
    options: {
        agentVersion?: string;
        agentType?: string;
        conversationId?: string;
        userId?: string;
        tenantId?: string;
        input?: string;
        inputTokens?: number;
        correlationId?: string;
        parentSpanId?: string;
    } = {},
) {
    const attributes = createAgentSpanAttributes({
        agentName,
        agentVersion: options.agentVersion,
        agentType: options.agentType,
        executionId,
        conversationId: options.conversationId,
        userId: options.userId,
        tenantId: options.tenantId,
        correlationId: options.correlationId,
        input: options.input,
        inputTokens: options.inputTokens,
    });

    return createSemanticSpanOptions(SPAN_NAMES.AGENT_EXECUTE, attributes, {
        parent: options.parentSpanId
            ? { traceId: '', spanId: options.parentSpanId, traceFlags: 1 }
            : undefined,
    });
}

/**
 * Helper to create LLM call span with full semantic conventions
 */
export function createLLMCallSpan(
    system: string,
    model: string,
    options: {
        operation?: string;
        temperature?: number;
        maxTokens?: number;
        parentSpanId?: string;
    } = {},
) {
    const attributes = createLLMSpanAttributes({
        system,
        model,
        operation: options.operation,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
    });

    return createSemanticSpanOptions(SPAN_NAMES.LLM_CHAT, attributes, {
        parent: options.parentSpanId
            ? { traceId: '', spanId: options.parentSpanId, traceFlags: 1 }
            : undefined,
    });
}

/**
 * Helper to create tool execution span with full semantic conventions
 */
export function createToolExecutionSpan(
    toolName: string,
    executionId: string,
    options: {
        toolType?: string;
        parameters?: Record<string, unknown>;
        correlationId?: string;
        parentSpanId?: string;
    } = {},
) {
    const attributes = createToolSpanAttributes({
        toolName,
        toolType: options.toolType,
        executionId,
        parameters: options.parameters,
        correlationId: options.correlationId,
    });

    return createSemanticSpanOptions(SPAN_NAMES.TOOL_EXECUTE, attributes, {
        parent: options.parentSpanId
            ? { traceId: '', spanId: options.parentSpanId, traceFlags: 1 }
            : undefined,
    });
}
