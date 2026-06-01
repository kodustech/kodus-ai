import './instrument';
import 'source-map-support/register';

import { initPyroscope } from '@libs/core/infrastructure/config/profiling/pyroscope';
import { reportExceptionToSentry } from '@libs/core/infrastructure/config/log/sentry';
import { configureLongFetchTimeouts } from '@libs/core/infrastructure/http/fetch-timeouts';

// Bump undici HTTP timeouts for any outgoing fetch() — webhooks itself
// doesn't make long LLM calls today, but keeping the dispatcher aligned
// across entry points avoids surprises if that ever changes.
configureLongFetchTimeouts();

// Initialize profiling early (before NestJS bootstrap)
initPyroscope({ appName: 'kodus-webhooks' });

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as bodyParser from 'body-parser';
import expressRateLimit from 'express-rate-limit';
import helmet from 'helmet';
import * as volleyball from 'volleyball';

import { HttpServerConfiguration } from '@libs/core/infrastructure/config/types';
import { LoggerWrapperService } from '@libs/core/log/loggerWrapper.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { environment } from '@libs/ee/configs/environment';
import { WebhookHandlerModule } from './modules/webhook-handler.module';

declare const module: any;

function handleNestJSWebpackHmr(app: INestApplication, module: any) {
    if (module.hot) {
        module.hot.accept();
        module.hot.dispose(() => app.close());
    }
}

async function bootstrap() {
    process.env.COMPONENT_TYPE = 'webhook';
    const app = await NestFactory.create<NestExpressApplication>(
        WebhookHandlerModule,
        { snapshot: true },
    );

    const logger = app.get(LoggerWrapperService);
    app.useLogger(logger);

    try {
        logger.log('Entering bootstrap try block...', 'Bootstrap');
        logger.log('Initializing Webhooks...', 'Bootstrap');

        const configService: ConfigService = app.get(ConfigService);
        await app.get(ObservabilityService).init('webhooks');

        const config = configService.get<HttpServerConfiguration>('server');
        const { host, rateLimit } = config;

        const webhookPortRaw = process.env.API_WEBHOOKS_PORT;
        const webhookPortParsed = webhookPortRaw
            ? parseInt(webhookPortRaw, 10)
            : NaN;

        if (!Number.isFinite(webhookPortParsed) || webhookPortParsed <= 0) {
            throw new Error(
                'API_WEBHOOKS_PORT is required and must be a positive integer',
            );
        }

        const webhookPort = webhookPortParsed;

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

        app.use(volleyball);
        app.use(helmet());

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
                extra: { component: 'webhook', type: 'uncaughtException' },
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
                extra: { component: 'webhook', type: 'unhandledRejection' },
            });
            logger.error({
                message: `Unhandled Rejection: ${reason?.message || reason}`,
                context: 'GlobalExceptionHandler',
                error,
            });
        });

        app.use(
            bodyParser.json({
                limit: '25mb',
                verify: (req: any, _res, buf) => {
                    req.rawBody = buf;
                },
            }),
        );
        app.use(bodyParser.urlencoded({ limit: '25mb', extended: true }));
        app.set('trust proxy', 1);

        app.enableShutdownHooks();

        console.log(
            `[Webhooks] - Running in ${
                environment.API_CLOUD_MODE ? 'CLOUD' : 'SELF-HOSTED'
            } mode`,
        );
        await app.listen(webhookPort, host, () => {
            console.log(`[Webhooks] - Ready on http://${host}:${webhookPort}`);
        });

        handleNestJSWebpackHmr(app, module);
    } catch (error) {
        void reportExceptionToSentry(error, {
            context: 'Bootstrap',
            extra: { component: 'webhook', phase: 'bootstrap' },
        });
        logger.error(
            `Bootstrap failed inside catch block: ${error.message}`,
            error.stack,
            'Bootstrap',
        );
        await app.close();
        process.exit(1);
    }
}

bootstrap();
