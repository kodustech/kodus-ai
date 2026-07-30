import { TraceItem, SpanExporter } from '../types';
import { IOtelAdapter, SpanOptions } from '../core/otel-adapter';

/**
 * Exporter that sends traces to OpenTelemetry via the API
 * This acts as a bridge: our system -> OTel API -> OTel SDK (if configured by user) -> OTLP Collector
 */
export class OtlpTraceExporter implements SpanExporter {
    public readonly name = 'OtlpTraceExporter';
    private adapter: IOtelAdapter;
    private isEnabled: boolean = false;

    constructor(adapter: IOtelAdapter) {
        this.adapter = adapter;
        this.isEnabled = adapter.isAvailable();
    }

    async initialize(): Promise<void> {
        // Nothing to init here, relies on global OTel SDK being initialized by the user
    }

    async export(items: TraceItem[]): Promise<void> {
        // Since we are bridging AFTER execution (TraceItem is a completed span),
        // we need to "replay" these spans into the OTel API if we want them exported.
        // HOWEVER, the standard OTel way is to start the span using OTel API *during* execution.

        // Strategy: Since we have a dual-write architecture where SimpleTracer creates the span first,
        // we will reconstruct the span in OTel just for export purposes.
        // This is a "reporting" span.

        // Note: Ideally, TelemetrySystem should start both spans, but for this "Evolve" feature
        // with minimal disruption, we export the completed item.

        if (!this.isEnabled) return;

        for (const item of items) {
            this.reportToOtel(item);
        }
    }

    /**
     * Reconstructs and reports a completed TraceItem to OTel
     */
    private reportToOtel(item: TraceItem): void {
        const tracer = this.adapter.getTracer('kodus-ai');

        // We can't really "insert" a past span into OTel easily without a custom SpanProcessor.
        // But we can create a span with explicit start/end times.
        const options: SpanOptions = {
            startTime: item.startTime,
            attributes: item.attributes,
            kind: 0, // Internal
        };

        // Note: Linking to parent context is tricky here because we only have IDs.
        // In a full implementation, we would create a Context from the traceId/spanId.

        const span = tracer.startSpan(item.name, options);

        // Set Status
        if (item.status.code === 'error') {
            span.setStatus({ code: 2, message: item.status.message }); // 2 = Error in OTel
        } else {
            span.setStatus({ code: 1 }); // 1 = Ok
        }

        // End with original duration
        span.end(item.endTime);
    }

    // Support unified interface methods
    async exportTrace(item: TraceItem): Promise<void> {
        return this.export([item]);
    }

    async exportLog(): Promise<void> {
        // OTLP Logs are handled separately, skipping for now as per plan focus on Tracing
    }

    async exportError(): Promise<void> {
        // Errors are usually part of spans in OTel
    }

    async flush(): Promise<void> {
        // No-op, handled by SDK
    }

    async shutdown(): Promise<void> {
        this.isEnabled = false;
    }
}
