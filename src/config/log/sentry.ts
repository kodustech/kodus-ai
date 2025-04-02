import * as Sentry from '@sentry/node';
import {
    SentryPropagator,
    SentrySampler,
    SentrySpanProcessor
} from '@sentry/opentelemetry';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { Resource } from '@opentelemetry/resources';
import { detectResourcesSync } from '@opentelemetry/resources';
import { envDetector, hostDetector, processDetector } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';

export function setupSentryAndOpenTelemetry() {
    const environment = process.env.API_NODE_ENV || 'development';
    const dsn = process.env.API_SENTRY_DNS;
    const serviceName = 'kodus-orchestrator';

    if (!dsn) {
        console.log('API_SENTRY_DNS não definido. Sentry desabilitado.');
        return;
    }

    console.log('Configurando Sentry com DSN:', dsn);

    // Inicializar o Sentry
    const sentryClient = Sentry.init({
        dsn: dsn,
        integrations: [nodeProfilingIntegration()],
        environment: environment,
        release: `kodus-orchestrator@${process.env.SENTRY_RELEASE || environment}`,
        debug: false,
        skipOpenTelemetrySetup: true, // Importante: true porque configuramos manualmente
        tracesSampleRate: 1.0,
    });

    const provider = new NodeTracerProvider({
        sampler: sentryClient ? new SentrySampler(sentryClient) : undefined,
        spanProcessors: [
            new SentrySpanProcessor(),
        ],
    });

    provider.register({
        propagator: new SentryPropagator(),
        contextManager: new Sentry.SentryContextManager(),
    });

    registerInstrumentations({
        instrumentations: [
            new HttpInstrumentation(),
            new ExpressInstrumentation(),
            new NestInstrumentation(),

            new PinoInstrumentation({
                logKeys: {
                    traceId: 'traceId',
                    spanId: 'spanId',
                    traceFlags: 'traceFlags',
                },
                logHook: (span, record) => {
                    record['resource.service.name'] = serviceName;
                },
            }),
        ],
    });

    Sentry.validateOpenTelemetrySetup();

    global.getTraceContext = () => {
        try {
            const activeContext = require('@opentelemetry/api').context.active();
            const spanContext = require('@opentelemetry/api').trace.getSpanContext(activeContext);

            if (!spanContext) {
                return {
                    traceId: null,
                    spanId: null,
                };
            }

            return {
                traceId: spanContext.traceId,
                spanId: spanContext.spanId,
            };
        } catch (error) {
            console.error('Error getting trace context:', error);
            return {
                traceId: null,
                spanId: null,
            };
        }
    };

    console.log('Sentry e OpenTelemetry configurados com sucesso');
}

// Exportar uma função auxiliar para criar spans manualmente
export function createSpan(name: string, fn: (span: any) => any) {
    const tracer = require('@opentelemetry/api').trace.getTracer('kodus-orchestrator');
    return tracer.startActiveSpan(name, (span) => {
        try {
            return fn(span);
        } catch (error) {
            span.recordException(error);
            throw error;
        } finally {
            span.end();
        }
    });
}