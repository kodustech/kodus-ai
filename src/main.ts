import 'source-map-support/register';
import { environment } from '@/ee/configs/environment';

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { useContainer } from 'class-validator';
import expressRateLimit from 'express-rate-limit';
import helmet from 'helmet';
import * as volleyball from 'volleyball';
import * as bodyParser from 'body-parser';
import { HttpServerConfiguration } from './config/types/http/http-server.type';
import { AppModule } from './modules/app.module';
import { PinoLoggerService } from './core/infrastructure/adapters/services/logger/pino.service';
// import { setupOpenTelemetry } from './config/log/otel';

async function bootstrap() {
    console.log('Exit listeners:', process.listeners('exit').length);

    // Inicializa OpenTelemetry primeiro
    // const otelInitialized = setupOpenTelemetry();

    // Depois inicializa Sentry
    import('./config/log/sentry');

    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        snapshot: true,
    });

    const pinoLogger = app.get(PinoLoggerService);
    app.useLogger(pinoLogger);

    const configService: ConfigService = app.get(ConfigService);
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
        expressRateLimit({
            windowMs: rateLimit.rateInterval,
            max: rateLimit.rateMaxRequest,
            legacyHeaders: false,
        }),
    );

    app.use(bodyParser.urlencoded({ extended: true }));
    app.set('trust proxy', '127.0.0.1');

    app.useStaticAssets('static');
    useContainer(app.select(AppModule), { fallbackOnErrors: true });

    console.log(
        `[BOOT] - Running in ${environment.API_CLOUD_MODE ? 'CLOUD' : 'SELF-HOSTED'} mode`,
    );
    await app.listen(port, host, () => {
        console.log(
            `[Server] - Ready on http://${host}:${port}`,
            'Application',
        );
    });
}

bootstrap();
