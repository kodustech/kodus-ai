import {
    SentryPropagator,
} from '@sentry/opentelemetry';

import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { trace } from '@opentelemetry/api';
import { SentryContextManager } from '@sentry/nestjs';

export function setupOpenTelemetry() {
    const provider = new NodeTracerProvider();


    provider.register({
        propagator: new SentryPropagator(),
        contextManager: new SentryContextManager(),
    });

    registerInstrumentations({
        instrumentations: [
            new PinoInstrumentation({
                logKeys: {
                    traceId: 'traceId',
                    spanId: 'spanId',
                    traceFlags: 'traceFlags',
                },
            }),
            new NestInstrumentation(),
        ],
    });

    trace.setGlobalTracerProvider(provider);

    console.log('OpenTelemetry SDK inicializado com SentrySpanProcessor');
}
