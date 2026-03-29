import './instrument';
import 'source-map-support/register';

import { initPyroscope } from '@libs/core/infrastructure/config/profiling/pyroscope';
import { reportExceptionToSentry } from '@libs/core/infrastructure/config/log/sentry';

// Initialize profiling early (before NestJS bootstrap)
initPyroscope({ appName: 'kodus-worker' });

import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { LoggerWrapperService } from '@libs/core/log/loggerWrapper.service';
import { ObservabilityService } from '@libs/core/log/observability.service';

import { WorkerModule } from './worker.module';

declare const module: any;

function handleNestJSWebpackHmr(app: INestApplicationContext, module: any) {
    if (module.hot) {
        module.hot.accept();
        module.hot.dispose(() => app.close());
    }
}

async function bootstrap() {
    process.env.COMPONENT_TYPE = 'worker';
    let appContext: INestApplicationContext | undefined;
    let logger: LoggerWrapperService | undefined;

    try {
        appContext = await NestFactory.createApplicationContext(WorkerModule, {
            snapshot: true,
        });

        logger = appContext.get(LoggerWrapperService);
        appContext.useLogger(logger);

        logger.log('Entering bootstrap try block...', 'Bootstrap');
        logger.log('Initializing Worker...', 'Bootstrap');

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

        console.log('[Worker] - Initialized and running.');

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
