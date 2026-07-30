export * from './types';

import { ObservabilitySystem } from './observability';
export { ObservabilitySystem } from './observability';
import { ObservabilityConfig } from './types';
export { TelemetrySystem } from './telemetry';
export { createLogger, SimpleLogger } from '@libs/core/log/logger';

export {
    ExecutionTracker,
    executionTracker,
    startExecutionTracking,
    addExecutionStep,
    completeExecutionTracking,
    failExecutionTracking,
    getExecutionTracking,
} from './execution-tracker';

let globalObservability: ObservabilitySystem | undefined;

export function getObservability(
    config?: Partial<ObservabilityConfig>,
): ObservabilitySystem {
    if (!globalObservability) {
        globalObservability = new ObservabilitySystem(config);
    }
    return globalObservability;
}

export function initObservability(
    config?: Partial<ObservabilityConfig>,
): ObservabilitySystem {
    globalObservability = new ObservabilitySystem(config);
    return globalObservability;
}

export function markSpanOk(span: any) {
    if (span && typeof span.setStatus === 'function') {
        span.setStatus({ code: 'ok' });
    }
}

export function applyErrorToSpan(span: any, error: Error) {
    if (span && typeof span.recordException === 'function') {
        span.recordException(error);
        span.setStatus({ code: 'error', message: error.message });
    }
}

export {
    getExecutionTraceability,
    getExecutionSummary,
} from './traceability';

export type { TraceabilityResponse } from './traceability';

// New Exports for OTLP
export { OtelAdapter } from './core/otel-adapter';
export { OtlpTraceExporter } from './exporters/otlp-exporter';
export { MongoDBExporter } from './exporters/mongodb-exporter';

// Re-exported so consumers (ObservabilityService, automationCodeReview) get the
// same surface they previously imported from the legacy flow engine.
export { IdGenerator } from '@libs/core/utils/id-generator';
export { StorageEnum } from './flow-types';
