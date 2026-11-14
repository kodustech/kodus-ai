import { metrics, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, ConsoleSpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

/**
 * OpenTelemetry for a Runtime process: W3C propagation, traces to OTLP when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set (console with OTEL_TRACES_EXPORTER=console),
 * metrics on a Prometheus endpoint on `metricsPort` (RUNTIME_METRICS_PORT, from
 * the validated config). Only the standard OTEL_* variables are read here,
 * as the OpenTelemetry SDK documents them.
 */
export async function setupRuntimeOtel(serviceName: string, metricsPort?: number): Promise<() => Promise<void>> {
    process.env.OTEL_SERVICE_NAME ??= serviceName;
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());

    const processors: SpanProcessor[] = [];
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
        const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
        processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
    }
    if (process.env.OTEL_TRACES_EXPORTER === 'console') processors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
    const tracer = new NodeTracerProvider({ spanProcessors: processors });
    tracer.register();

    let meter: MeterProvider | undefined;
    if (metricsPort) {
        const exporter = new PrometheusExporter({ port: metricsPort, host: '0.0.0.0' });
        meter = new MeterProvider({ readers: [exporter] });
        metrics.setGlobalMeterProvider(meter);
    }
    return async () => {
        await tracer.shutdown().catch(() => undefined);
        await meter?.shutdown().catch(() => undefined);
        trace.disable();
    };
}
