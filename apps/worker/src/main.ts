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

import { hostname } from 'os';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { LoggerWrapperService } from '@libs/core/log/loggerWrapper.service';
import {
    runtimeIdentity,
    setRuntimeTaskId,
} from '@libs/core/log/runtime-identity';
import { ObservabilityService } from '@libs/core/log/observability.service';

import { securityScanSliceJobId } from '@libs/core/workflow/infrastructure/security-scan-runtime';
import { runSecurityScanSliceProcess } from './run-security-scan-slice-process';

import { resolveWorkerRole } from './worker-role';
import { WorkerModule } from './worker.module';
import { startEventLoopMonitor } from './event-loop-monitor';
import {
    SECURITY_SCAN_WORKER_CHANNELS,
    startHealthProbe,
} from './health-probe';

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
    // Before the app boots, so every log line and alert from boot on names
    // its ECS task (the release comes from RELEASE_VERSION in the image).
    // A slice child skips it: it runs only the engine, off the consumer.
    const taskId = securityScanSliceJobId() ? undefined : await ecsTaskId();
    setRuntimeTaskId(taskId);

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

        // A slice child runs the engine only: no health port (the parent
        // already bound :3334) and no queue consumer. Skip Nest shutdown
        // hooks so SIGTERM is ours: abort the processor, release the
        // sandbox, then close.
        const sliceJobId = securityScanSliceJobId();

        // Kept running through shutdown (unref'd): the drain is when we most
        // need to see whether the thread is blocked. The stall watchdog
        // captures where a stall is stuck and alerts while it happens; not in
        // a slice child, whose whole point is to run heavy work off the
        // consumer's event loop. The ECS task id joins a stall alert to the
        // task ECS stops (resolved before boot, above).
        startEventLoopMonitor(
            sliceJobId
                ? {}
                : {
                      stallWatchdog: {
                          // Critical: a stall past alertMs (75s), about to be killed.
                          heartbeatUrl:
                              process.env
                                  .API_BETTERSTACK_HEARTBEAT_WORKER_STALL_URL ??
                              '',
                          // Early warning: every stall, at its first report (20s).
                          warnHeartbeatUrl:
                              process.env
                                  .API_BETTERSTACK_HEARTBEAT_WORKER_STALL_WARN_URL ??
                              '',
                          identity: {
                              role,
                              instanceId: hostname(),
                              ...runtimeIdentity(),
                          },
                      },
                  },
        );

        if (sliceJobId) {
            logger?.log(
                `Running security-scan slice ${sliceJobId}`,
                'Bootstrap',
            );
            const code = await runSecurityScanSliceProcess(
                appContext,
                sliceJobId,
                {
                    onError: (err) =>
                        logger?.error({
                            message: `Security-scan slice failed: ${err.message}`,
                            context: 'Bootstrap',
                            error: err,
                            metadata: { jobId: sliceJobId },
                        }),
                },
            );
            process.exit(code);
        }

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
        // The code-review and security-scan roles subscribe to AMQP, each
        // on its own channels; the analytics role has no RabbitMQ consumers,
        // so checking AMQP health there would flap the task unhealthy
        // permanently.
        const healthServer = startHealthProbe({
            port: healthPort,
            appContext,
            requireAmqp:
                role !== 'analytics' &&
                process.env.API_RABBITMQ_ENABLED !== 'false',
            ...(role === 'security-scan'
                ? { requiredChannels: SECURITY_SCAN_WORKER_CHANNELS }
                : {}),
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

/**
 * This task's id from the ECS task metadata endpoint, best effort (absent
 * outside ECS or when the endpoint does not answer within 2s).
 */
async function ecsTaskId(): Promise<string | undefined> {
    const uri = process.env.ECS_CONTAINER_METADATA_URI_V4;
    if (!uri) return undefined;
    try {
        const res = await fetch(`${uri}/task`, {
            signal: AbortSignal.timeout(2_000),
        });
        const body = (await res.json()) as { TaskARN?: string };
        return (
            String(body?.TaskARN ?? '')
                .split('/')
                .pop() || undefined
        );
    } catch {
        return undefined;
    }
}
