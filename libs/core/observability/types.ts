/**
 * Core types for the observability system
 */
import { LogLevel } from './flow-types';

/**
 * Minimal ExecutionContext interface compatible with NestJS
 * This avoids hard dependency on @nestjs/common
 */
export interface ExecutionContext {
    switchToHttp(): {
        getRequest(): { url?: string; [key: string]: unknown };
        getResponse(): unknown;
        getNext(): unknown;
    };
    [key: string]: unknown;
}

export type LogArguments = {
    message: string;
    context: ExecutionContext | string;
    serviceName?: string;
    error?: Error;
    metadata?: Record<string, any>;
};

export type SpanKind =
    | 'internal'
    | 'server'
    | 'client'
    | 'producer'
    | 'consumer';

export type SpanStatus = { code: 'ok' | 'error'; message?: string };

export interface SpanContext {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    traceFlags: number;
}

export interface SpanOptions {
    parent?: SpanContext;
    kind?: SpanKind;
    startTime?: number;
    attributes?: Record<string, string | number | boolean>;
    tenantId?: string;
    correlationId?: string;
    metadata?: Record<string, unknown>;
}

export interface Span {
    setAttribute(key: string, value: string | number | boolean): this;
    setAttributes(attributes: Record<string, string | number | boolean>): this;
    setStatus(status: SpanStatus): this;
    recordException(error: Error): this;
    addEvent(
        name: string,
        attributes?: Record<string, string | number | boolean>,
    ): this;
    end(): void;
    getSpanContext(): SpanContext;
    isRecording(): boolean;
    getName(): string;
    getKind(): SpanKind;
    getDuration(): number | undefined;
    getAttributes(): Record<string, string | number | boolean>;
    getEvents(): ReadonlyArray<{
        timestamp: number;
        name: string;
        attributes?: Record<string, string | number | boolean> | undefined;
    }>;
    getStatus(): SpanStatus;
    toTraceItem(): TraceItem;
}

export interface Tracer {
    startSpan(name: string, options?: SpanOptions): Span;
    getCurrentSpan(): Span | undefined;
    setCurrentSpan(span: Span): void;
    removeCurrentSpan(): void;
}

export interface TracerProvider {
    getTracer(name: string, version?: string): Tracer;
}

// Exporter interfaces
export interface TelemetryExporter {
    export(items: TraceItem[]): Promise<void>;
    flush?(): Promise<void>;
    shutdown?(): Promise<void>;
}

export interface SpanExporter {
    export(items: TraceItem[]): Promise<void>;
    flush?(): Promise<void>;
    shutdown?(): Promise<void>;
}

export interface LogExporter {
    export(
        level: LogLevel,
        message: string,
        context?: LogContext,
        error?: Error,
    ): void;
}

export interface LogProcessor {
    process(
        level: LogLevel,
        message: string,
        context?: LogContext,
        error?: Error,
    ): void;
}

export interface SpanProcessor {
    process(item: TraceItem): Promise<void> | void;
}

// Configuration types
export interface TelemetryConfig {
    enabled: boolean;
    serviceName?: string;
    sampling?: {
        rate: number; // 0.0 to 1.0
        strategy?: 'probabilistic' | 'always' | 'never';
        rules?: Array<{
            service?: string;
            operation?: string;
            rate: number;
        }>;
    };
    features?: {
        traceSpans?: boolean;
        traceEvents?: boolean;
        traceKernel?: boolean;
        traceSnapshots?: boolean;
        tracePersistence?: boolean;
    };
    globalAttributes?: Record<string, string | number | boolean>;
}

export interface MongoDBConfig {
    type: 'mongodb';
    connectionString?: string;
    database?: string;
    collections?: {
        logs?: string;
        telemetry?: string;
    };
    batchSize?: number;
    flushIntervalMs?: number;
    ttlDays?: number;
    enableObservability?: boolean;
    secondaryIndexes?: string[];
    bucketKeys?: string[];
}

// Main observability configuration
export interface ObservabilityConfig {
    enabled: boolean;
    serviceName?: string;
    environment?: 'development' | 'production' | 'test';
    logging?: {
        level?: LogLevel;
        enabled?: boolean;
        outputs?: string[];
        filePath?: string;
    };
    telemetry?: Partial<TelemetryConfig>;
    mongodb?: MongoDBConfig;
    apiPort?: number;
    otlp?: {
        enabled: boolean;
        endpoint?: string;
        protocol?: 'http/proto' | 'http/json' | 'grpc';
        headers?: Record<string, string>;
        timeoutMs?: number;
    };
}

// Agent tracking types
export interface AgentExecutionOptions {
    agentName: string;
    agentVersion?: string;
    agentType?: string;
    input?: unknown;
    inputTokens?: number;
    correlationId?: string;
    tenantId?: string;
    sessionId?: string;
    userId?: string;
    metadata?: Record<string, any>;
}

export interface AgentExecutionResult {
    executionId: string;
    agentName: string;
    agentVersion?: string;
    agentType?: string;
    input?: unknown;
    output?: unknown;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cost?: number;
    duration: number;
    status: 'success' | 'error' | 'timeout';
    error?: string;
    correlationId: string;
    tenantId?: string;
    sessionId?: string;
    userId?: string;
    startedAt: number;
    finishedAt: number;
    metadata?: Record<string, any>;
}

// OpenTelemetry Semantic Convention Keys
export type GenAISpanAttributeKey =
    // Gen AI Request Attributes
    | 'gen_ai.system'
    | 'gen_ai.request.model'
    | 'gen_ai.request.max_tokens'
    | 'gen_ai.request.temperature'
    | 'gen_ai.request.top_p'
    | 'gen_ai.request.top_k'
    | 'gen_ai.request.frequency_penalty'
    | 'gen_ai.request.presence_penalty'
    | 'gen_ai.request.stop_sequences'
    | 'gen_ai.operation.name'
    // Gen AI Response Attributes
    | 'gen_ai.response.finish_reasons'
    | 'gen_ai.response.id'
    | 'gen_ai.response.model'
    // Gen AI Usage Attributes
    | 'gen_ai.usage.input_tokens'
    | 'gen_ai.usage.output_tokens'
    | 'gen_ai.usage.total_tokens'
    | 'gen_ai.usage.cost'
    // Agent-specific attributes (our extension)
    | 'agent.name'
    | 'agent.version'
    | 'agent.type'
    | 'agent.execution.id'
    | 'agent.conversation.id'
    | 'agent.user.id'
    | 'agent.tenant.id'
    | 'agent.correlation.id'
    // Tool-specific attributes
    | 'tool.name'
    | 'tool.type'
    | 'tool.execution.id'
    | 'tool.parameters'
    | 'tool.result.size'
    | 'tool.error.type'
    | 'tool.correlation.id'
    // Workflow attributes
    | 'workflow.name'
    | 'workflow.step'
    | 'workflow.execution.id'
    | 'workflow.parent.step';

// OpenTelemetry Semantic Conventions for Generative AI
export interface GenAISpanAttributes {
    [key: string]:
        | string
        | number
        | boolean
        | string[]
        | Record<string, unknown>
        | undefined;
}

// Type-safe attributes using semantic convention keys
export type TypedGenAISpanAttributes = Partial<
    Record<
        GenAISpanAttributeKey,
        string | number | boolean | string[] | Record<string, unknown>
    >
>;

// Semantic Convention Constants (for easy usage)
export const GEN_AI = {
    // Gen AI Request Attributes
    SYSTEM: 'gen_ai.system' as const,
    REQUEST_MODEL: 'gen_ai.request.model' as const,
    REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens' as const,
    REQUEST_TEMPERATURE: 'gen_ai.request.temperature' as const,
    REQUEST_TOP_P: 'gen_ai.request.top_p' as const,
    REQUEST_TOP_K: 'gen_ai.request.top_k' as const,
    REQUEST_FREQUENCY_PENALTY: 'gen_ai.request.frequency_penalty' as const,
    REQUEST_PRESENCE_PENALTY: 'gen_ai.request.presence_penalty' as const,
    REQUEST_STOP_SEQUENCES: 'gen_ai.request.stop_sequences' as const,
    OPERATION_NAME: 'gen_ai.operation.name' as const,

    // Gen AI Response Attributes
    RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons' as const,
    RESPONSE_ID: 'gen_ai.response.id' as const,
    RESPONSE_MODEL: 'gen_ai.response.model' as const,

    // Gen AI Usage Attributes
    USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens' as const,
    USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens' as const,
    USAGE_TOTAL_TOKENS: 'gen_ai.usage.total_tokens' as const,
    USAGE_COST: 'gen_ai.usage.cost' as const,
} as const;

export const AGENT = {
    NAME: 'agent.name' as const,
    VERSION: 'agent.version' as const,
    TYPE: 'agent.type' as const,
    EXECUTION_ID: 'agent.execution.id' as const,
    CONVERSATION_ID: 'agent.conversation.id' as const,
    USER_ID: 'agent.user.id' as const,
    TENANT_ID: 'agent.tenant.id' as const,
    CORRELATION_ID: 'agent.correlation.id' as const,
} as const;

export const TOOL = {
    NAME: 'tool.name' as const,
    TYPE: 'tool.type' as const,
    EXECUTION_ID: 'tool.execution.id' as const,
    PARAMETERS: 'tool.parameters' as const,
    RESULT_SIZE: 'tool.result.size' as const,
    ERROR_TYPE: 'tool.error.type' as const,
    CORRELATION_ID: 'tool.correlation.id' as const,
} as const;

export const WORKFLOW = {
    NAME: 'workflow.name' as const,
    STEP: 'workflow.step' as const,
    EXECUTION_ID: 'workflow.execution.id' as const,
    PARENT_STEP: 'workflow.parent.step' as const,
} as const;

export interface TraceItem {
    name: string;
    context: SpanContext;
    attributes: Record<string, string | number | boolean>;
    startTime: number;
    endTime: number;
    duration: number;
    status: SpanStatus;
}

export interface LogContext {
    correlationId?: string;
    tenantId?: string;
    executionId?: string;
    sessionId?: string;
    [key: string]: unknown;
}

export interface ObservabilityContext {
    correlationId: string;
    tenantId: string;
    executionId?: string;
    sessionId?: string;
    startTime: number;
    [key: string]: unknown;
}

// Additional configuration interfaces

export interface ExecutionStep {
    id: string;
    timestamp: number;
    type: 'start' | 'think' | 'action' | 'tool' | 'finish' | 'error';
    component: string;
    data: Record<string, unknown>;
    duration?: number;
}

export interface ExecutionCycle {
    executionId: string;
    agentName: string;
    correlationId: string;
    startTime: number;
    endTime?: number;
    totalDuration?: number;
    steps: ExecutionStep[];
    input?: unknown;
    output?: unknown;
    error?: Error;
    status: 'running' | 'completed' | 'error';
    metadata: {
        tenantId?: string;
        sessionId?: string;
        threadId?: string;
        userId?: string;
    };
}

/**
 * Interfaces for exporters
 */
export interface SpanExporter {
    export(items: TraceItem[]): Promise<void>;
    flush?(): Promise<void>;
    shutdown?(): Promise<void>;
}

export interface LogExporter {
    export(
        level: LogLevel,
        message: string,
        context?: LogContext,
        error?: Error,
    ): void;
    flush?(): Promise<void>;
    shutdown?(): Promise<void>;
}

/**
 * Unified Exporter Interface
 */
export interface ObservabilityExporter {
    name: string;
    initialize?(): Promise<void>;
    exportTrace(item: TraceItem): Promise<void>;
    exportLog(
        level: LogLevel,
        message: string,
        context?: LogContext,
        error?: Error,
    ): Promise<void>;
    flush(): Promise<void>;
    shutdown(): Promise<void>;
}

/**
 * Interfaces for processors
 */
export interface SpanProcessor {
    process(item: TraceItem): Promise<void>;
    flush?(): Promise<void>;
    shutdown?(): Promise<void>;
}

export interface LogProcessor {
    process(
        level: LogLevel,
        message: string,
        context?: LogContext,
        error?: Error,
    ): void;
    flush?(): Promise<void>;
    shutdown?(): Promise<void>;
}
