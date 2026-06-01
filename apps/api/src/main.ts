// Force stdout/stderr to be synchronous so logs aren't lost when the
// process exits abruptly (unhandled rejection / sync throw in a module
// constructor). Without this, Node line-buffers piped stdout and any
// pending output is dropped on `process.exit(1)` — which is exactly
// what we were seeing on ECS: bootstrap dies and CloudWatch never gets
// the stack trace.
if ((process.stdout as any)._handle?.setBlocking) {
    (process.stdout as any)._handle.setBlocking(true);
}
if ((process.stderr as any)._handle?.setBlocking) {
    (process.stderr as any)._handle.setBlocking(true);
}

// Catch errors thrown by module-side-effect imports (e.g. instrument.ts,
// setupSentry, registerLangfuseStandalone, ApiModule eval) before any
// other handler is installed. Default Node 22 behavior on unhandled
// rejection is to exit with code 1 — fine, but we want the stack first.
process.on('unhandledRejection', (reason) => {
     
    console.error(
        '[BOOTSTRAP-EARLY] unhandledRejection before app handler installed:',
        reason instanceof Error ? reason.stack || reason.message : reason,
    );
    process.exit(1);
});
process.on('uncaughtException', (err) => {
     
    console.error(
        '[BOOTSTRAP-EARLY] uncaughtException before app handler installed:',
        err?.stack || err?.message || err,
    );
    process.exit(1);
});

import './instrument';
import 'source-map-support/register';
import { environment } from '@libs/ee/configs/environment';
import { initPyroscope } from '@libs/core/infrastructure/config/profiling/pyroscope';
import { reportExceptionToSentry } from '@libs/core/infrastructure/config/log/sentry';
import { configureLongFetchTimeouts } from '@libs/core/infrastructure/http/fetch-timeouts';

// Bump undici HTTP timeouts before any fetch() happens so long-running
// LLM calls don't get aborted by the HTTP layer's default 5-minute
// headersTimeout. Aligns with LLM_CALL_TIMEOUT_MS in agent-loop.ts.
configureLongFetchTimeouts();

// Initialize profiling early (before NestJS bootstrap)
initPyroscope({ appName: 'kodus-api' });

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';
import * as compression from 'compression';
import { useContainer } from 'class-validator';
import expressRateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import helmet from 'helmet';
import * as volleyball from 'volleyball';

import { HttpServerConfiguration } from '@libs/core/infrastructure/config/types';
import { ObservabilityService } from '@libs/core/log/observability.service';

import { ApiModule } from './api.module';
import { LoggerWrapperService } from '@libs/core/log/loggerWrapper.service';
import {
    buildDocsConfig,
    createDocsBasicAuthMiddleware,
} from './docs/docs-guard';
import { ApiErrorDto } from './dtos/api-error.dto';

declare const module: any;

function handleNestJSWebpackHmr(app: INestApplication, module: any) {
    if (module.hot) {
        module.hot.accept();
        module.hot.dispose(() => app.close());
    }
}

async function bootstrap() {
    process.env.COMPONENT_TYPE = 'api';
     
    console.log('[BOOTSTRAP] calling NestFactory.create...');
    // NOTE: `snapshot: true` was removed here. That flag requires
    // `@nestjs/devtools-integration` (not installed in this repo). It
    // used to be a silent no-op, but after the @nestjs/core 11.1.19 →
    // 11.1.21 bump it began to hang NestFactory.create() forever — no
    // throw, no log — which on ECS surfaced as a 46s-silent container
    // killed by the health check. Do not re-add without also adding
    // the devtools package.
    const app = await NestFactory.create<NestExpressApplication>(ApiModule);
     
    console.log('[BOOTSTRAP] NestFactory.create returned, wiring app...');

    const logger = app.get(LoggerWrapperService);
    app.useLogger(logger);

    try {
        logger.log('Entering bootstrap try block...', 'Bootstrap');
        logger.log('Initializing API...', 'Bootstrap');

        const configService: ConfigService = app.get(ConfigService);
        await app.get(ObservabilityService).init('api');

        const config = configService.get<HttpServerConfiguration>('server');
        const { host, port, rateLimit } = config;

        app.useGlobalPipes(
            new ValidationPipe({
                transform: true,
                whitelist: true,
                forbidNonWhitelisted: true,
                transformOptions: {
                    enableImplicitConversion: true,
                },
            }),
        );

        app.enableVersioning();
        app.enableCors({
            origin: true,
            methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
            credentials: true,
        });

        app.use(volleyball);
        app.use(helmet());
        app.use(
            compression({
                filter: (req, res) => {
                    if (req.headers['x-no-compression']) {
                        return false;
                    }
                    if (
                        res.getHeader('Content-Type') === 'text/event-stream' ||
                        req.url.includes('/events/')
                    ) {
                        return false;
                    }
                    return compression.filter(req, res);
                },
            }),
        );
        app.use(
            expressRateLimit({
                windowMs: rateLimit.rateInterval,
                max: rateLimit.rateMaxRequest,
                legacyHeaders: false,
            }),
        );

        process.on('uncaughtException', (error) => {
            void reportExceptionToSentry(error, {
                context: 'GlobalExceptionHandler',
                extra: { component: 'api', type: 'uncaughtException' },
            });
            logger.error({
                message: `Uncaught Exception: ${error.message}`,
                context: 'GlobalExceptionHandler',
                error,
            });
        });

        process.on('unhandledRejection', (reason: any) => {
            const error =
                reason instanceof Error ? reason : new Error(String(reason));
            void reportExceptionToSentry(error, {
                context: 'GlobalExceptionHandler',
                extra: { component: 'api', type: 'unhandledRejection' },
            });
            logger.error({
                message: `Unhandled Rejection: ${reason?.message || reason}`,
                context: 'GlobalExceptionHandler',
                error,
            });
        });

        app.use(bodyParser.json({ limit: '25mb' }));
        app.use(bodyParser.urlencoded({ limit: '25mb', extended: true }));
        app.set('trust proxy', 1);
        app.useStaticAssets('static');
        useContainer(app.select(ApiModule), { fallbackOnErrors: true });

        app.enableShutdownHooks();

        const apiPort = process.env.API_PORT
            ? parseInt(process.env.API_PORT, 10)
            : port;

        const docsConfig = buildDocsConfig(process.env);
        if (docsConfig.enabled) {
            const docsJsonPath = `${docsConfig.docsPath}-json`;
            app.use(
                [docsConfig.docsPath, docsConfig.specPath, docsJsonPath],
                createDocsBasicAuthMiddleware(
                    docsConfig.basicUser,
                    docsConfig.basicPass,
                ),
            );

            const swaggerBuilder = new DocumentBuilder()
                .setTitle('Kodus API')
                .setDescription('Public API for the Kodus platform.')
                .setVersion('1.0')
                .addBearerAuth(
                    {
                        type: 'http',
                        scheme: 'bearer',
                        bearerFormat: 'JWT',
                    },
                    'jwt',
                );

            const servers =
                docsConfig.servers.length > 0
                    ? docsConfig.servers
                    : [
                          {
                              url: `http://${
                                  host === '0.0.0.0' ? 'localhost' : host
                              }:${apiPort}`,
                              description: 'Local',
                          },
                      ];

            servers.forEach((server) => {
                swaggerBuilder.addServer(server.url, server.description);
            });

            [
                'Agent',
                'Auth',
                'CLI Review',
                'Code Base',
                'Code Management',
                'Code Review Logs',
                'Dry Run',
                'Health',
                'Integration',
                'Integration Config',
                'Internal Metrics',
                'Issues',
                'Kody Rules',
                'MCP',
                'Organization',
                'Organization Parameters',
                'Parameters',
                'Permissions',
                'Pull Request Messages',
                'Pull Requests',
                'Rule Likes',
                'SSO Config',
                'Team',
                'Team CLI Key',
                'Team Members',
                'Token Usage',
                'User',
                'Webhook Health',
                'Workflow Queue',
            ].forEach((tag) => swaggerBuilder.addTag(tag));

            const document = SwaggerModule.createDocument(
                app,
                swaggerBuilder.build(),
                {
                    extraModels: [ApiErrorDto],
                },
            );

            SwaggerModule.setup(docsConfig.docsPath, app, document, {
                swaggerOptions: {
                    supportedSubmitMethods: [],
                    tagsSorter: 'alpha',
                    operationsSorter: 'alpha',
                },
            });

            const httpAdapter = app.getHttpAdapter().getInstance();
            httpAdapter.get(
                docsConfig.specPath,
                (_req: Request, res: Response) => res.json(document),
            );
        }

        console.log(
            `[API] - Running in ${environment.API_CLOUD_MODE ? 'CLOUD' : 'SELF-HOSTED'} mode`,
        );
        await app.listen(apiPort, host, () => {
            console.log(`[API] - Ready on http://${host}:${apiPort}`);
        });

        handleNestJSWebpackHmr(app, module);
    } catch (error) {
        void reportExceptionToSentry(error, {
            context: 'Bootstrap',
            extra: { component: 'api', phase: 'bootstrap' },
        });
        // Full error dump to find circular dependency source
        console.error('=== BOOTSTRAP ERROR FULL DUMP ===');
        console.error('Message:', error.message);
        console.error('Stack:', error.stack);
        console.error(
            'Full error:',
            JSON.stringify(error, Object.getOwnPropertyNames(error), 2),
        );
        console.error('=================================');
        logger.error(
            `Bootstrap failed inside catch block: ${error.message}`,
            error.stack,
            'Bootstrap',
        );
        await app.close();
        process.exit(1);
    }
}

bootstrap().catch((err) => {
    // Surface errors thrown by NestFactory.create() or any pre-try
    // code path inside bootstrap(). Without this, an unhandled
    // rejection causes Node to exit silently on some terminals and
    // the actual stack never reaches CloudWatch.
     
    console.error(
        '[BOOTSTRAP] bootstrap() rejected:',
        err?.stack || err?.message || err,
    );
    process.exit(1);
});
