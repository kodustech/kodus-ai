import { metrics, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, ConsoleSpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { RedactingSpanExporter } from '@libs/runtime/telemetry/redacting-span-exporter';
import { type RuntimeProcessIdentity, runtimeResource } from './resource';

/**
 * OpenTelemetry for a Runtime process: W3C propagation, traces to OTLP when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set (console with OTEL_TRACES_EXPORTER=console),
 * metrics on a Prometheus endpoint on `metricsPort` (RUNTIME_METRICS_PORT, from
 * the validated config). Spans and metrics carry the process's resource
 * (`service.name` and the rest, resource.ts). Only the standard OTEL_*
 * variables are read here, as the OpenTelemetry SDK documents them. Every exporter is wrapped in the
 * RedactingSpanExporter: a span leaves the process with taxonomy attributes
 * only (docs/runtime/observability.md, "Never in telemetry").
 */
export async function setupRuntimeOtel(identity: RuntimeProcessIdentity, metricsPort?: number): Promise<() => Promise<void>> {
    const resource = runtimeResource(identity);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());

    const processors: SpanProcessor[] = [];
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
        const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
        processors.push(new BatchSpanProcessor(new RedactingSpanExporter(new OTLPTraceExporter())));
    }
    if (process.env.OTEL_TRACES_EXPORTER === 'console') processors.push(new BatchSpanProcessor(new RedactingSpanExporter(new ConsoleSpanExporter())));
    const tracer = new NodeTracerProvider({ resource, spanProcessors: processors });
    tracer.register();

    let meter: MeterProvider | undefined;
    if (metricsPort) {
        const exporter = new PrometheusExporter({ port: metricsPort, host: '0.0.0.0' });
        meter = new MeterProvider({ resource, readers: [exporter] });
        metrics.setGlobalMeterProvider(meter);
    }
    return async () => {
        // Best-effort flush on shutdown: an exporter that cannot flush must not hold the exit.
        await tracer.shutdown().catch(() => undefined);
        await meter?.shutdown().catch(() => undefined);
        trace.disable();
    };
}
