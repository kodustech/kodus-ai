import './instrument';
import 'source-map-support/register';

import { initPyroscope } from '@libs/core/infrastructure/config/profiling/pyroscope';
import { reportExceptionToSentry } from '@libs/core/infrastructure/config/log/sentry';
import { configureLongFetchTimeouts } from '@libs/core/infrastructure/http/fetch-timeouts';

// Bump undici HTTP timeouts before any fetch() happens — Gemini calls with
// high reasoning can take 4-7 minutes before the first byte. Must run
// before NestFactory so the global dispatcher is set for every module.
configureLongFetchTimeouts();

// Initialize profiling early (before NestJS bootstrap)
initPyroscope({ appName: 'kodus-worker' });

import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { LoggerWrapperService } from '@libs/core/log/loggerWrapper.service';
import { ObservabilityService } from '@libs/core/log/observability.service';

import { resolveWorkerRole } from './worker-role';
import { WorkerModule } from './worker.module';
import { startHealthProbe } from './health-probe';

declare const module: any;

function handleNestJSWebpackHmr(app: INestApplicationContext, module: any) {
    if (module.hot) {
        module.hot.accept();
        module.hot.dispose(() => app.close());
    }
}

async function bootstrap() {
    process.env.COMPONENT_TYPE = 'worker';
    // Resolve early so an invalid WORKER_ROLE fails the container start
    // instead of booting into an unexpected shape.
    const role = resolveWorkerRole();
    let appContext: INestApplicationContext | undefined;
    let logger: LoggerWrapperService | undefined;

    try {
        appContext = await NestFactory.createApplicationContext(
            WorkerModule.forRoot(),
            { snapshot: true },
        );

        logger = appContext.get(LoggerWrapperService);
        appContext.useLogger(logger);

        logger.log('Entering bootstrap try block...', 'Bootstrap');
        logger.log(`Initializing Worker (role=${role})...`, 'Bootstrap');

        process.on('uncaughtException', (error) => {
            void reportExceptionToSentry(error, {
                context: 'GlobalExceptionHandler',
                extra: { component: 'worker', type: 'uncaughtException' },
            });
            if (logger) {
                logger.error({
                    message: `Uncaught Exception: ${error.message}`,
                    context: 'GlobalExceptionHandler',
                    error,
                });
            } else {
                console.error(
                    'Uncaught Exception before logger was ready:',
                    error,
                );
            }
        });

        process.on('unhandledRejection', (reason: any) => {
            const error =
                reason instanceof Error ? reason : new Error(String(reason));
            void reportExceptionToSentry(error, {
                context: 'GlobalExceptionHandler',
                extra: { component: 'worker', type: 'unhandledRejection' },
            });
            if (logger) {
                logger.error({
                    message: `Unhandled Rejection: ${reason?.message || reason}`,
                    context: 'GlobalExceptionHandler',
                    error,
                });
            } else {
                console.error(
                    'Unhandled Rejection before logger was ready:',
                    reason,
                );
            }
        });

        await appContext.get(ObservabilityService).init('worker');

        appContext.enableShutdownHooks();

        // ECS-facing health probe: returns 503 when AMQP is disconnected so
        // the ECS task health check can detect a zombie worker (live Node
        // process but no consumers) and recycle the task. Port is
        // overridable but should match the healthCheck command in the
        // task-def.
        const healthPort = parseInt(
            process.env.WORKER_HEALTH_PORT ?? '3334',
            10,
        );
        // Only the code-review role subscribes to AMQP; the analytics
        // role has no RabbitMQ consumers, so checking AMQP health there
        // would flap the task unhealthy permanently.
        const healthServer = startHealthProbe({
            port: healthPort,
            appContext,
            requireAmqp:
                role === 'code-review' &&
                process.env.API_RABBITMQ_ENABLED !== 'false',
        });
        // Close the probe when Node receives SIGTERM so we don't keep the
        // port reserved during the grace period. Nest's own shutdown hooks
        // (enableShutdownHooks) fire after this on the same signal.
        const stopProbe = () => healthServer.close();
        process.once('SIGTERM', stopProbe);
        process.once('SIGINT', stopProbe);

        console.log(`[Worker] - Initialized and running (role=${role}).`);

        handleNestJSWebpackHmr(appContext, module);
    } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        void reportExceptionToSentry(error, {
            context: 'Bootstrap',
            extra: { component: 'worker', phase: 'bootstrap' },
        });
        const message = `Bootstrap failed: ${error.message}`;

        if (logger) {
            logger.error(message, error.stack, 'Bootstrap');
        } else {
            console.error(message, error.stack);
        }

        if (appContext) {
            await appContext.close();
        }
        process.exit(1);
    }
}

bootstrap();
