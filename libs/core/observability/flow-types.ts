/**
 * Types extracted from the legacy flow engine's `core/types/allTypes` for the ported
 * observability subsystem. Branded ID types are plain `string` aliases in flow,
 * so they are inlined here as `string` (no runtime brand). `LogLevel` is
 * re-exported from the already-ported core logger to keep a single source.
 */
import type { LogLevel } from '@libs/core/log/logger';

export type { LogLevel };

export enum StorageEnum {
    INMEMORY = 'memory',
    MONGODB = 'mongodb',
}

// Branded ID aliases (string in flow).
export type CallId = string;
export type CorrelationId = string;
export type EventId = string;
export type ExecutionId = string;
export type SessionId = string;
export type TenantId = string;

export interface ObservabilityStorageConfig {
    type: 'mongodb';
    connectionString: string;
    database: string;
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

export interface MongoDBExporterConfig {
    connectionString: string;
    database: string;
    collections: {
        logs: string;
        telemetry: string;
    };
    batchSize: number;
    flushIntervalMs: number;
    maxRetries: number;
    ttlDays: number;
    enableObservability: boolean;
    secondaryIndexes?: string[];
    bucketKeys?: string[];
}

export interface MongoDBLogItem {
    _id?: string;
    timestamp: Date;
    level: LogLevel;
    message: string;
    component: string;
    correlationId?: string;
    tenantId?: string;
    executionId?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    error?: {
        name: string;
        message: string;
        stack?: string;
    };
    createdAt: Date;
}

export interface MongoDBTelemetryItem {
    _id?: string;
    timestamp: Date;
    name: string;
    duration: number;
    correlationId?: string;
    tenantId?: string;
    executionId?: string;
    sessionId?: string;
    agentName?: string;
    toolName?: string;
    phase?: 'think' | 'act' | 'observe';
    attributes: Record<string, string | number | boolean>;
    status: 'ok' | 'error';
    error?: {
        name: string;
        message: string;
        stack?: string;
    };
    createdAt: Date;
}
