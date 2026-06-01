import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import {
    FastifyAdapter,
    NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { parseBasicAuth, validateBasicAuth } from './common/utils/docs-auth';

async function bootstrap() {
    const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        new FastifyAdapter(),
    );

    const origin = process.env.API_MCP_MANAGER_CORS_ORIGINS?.split(',') || '*';
    await app.register(import('@fastify/cors'), {
        origin,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        // allowedHeaders: ['Content-Type', 'Authorization'],
    });

    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            transform: true,
            forbidNonWhitelisted: true,
            transformOptions: {
                enableImplicitConversion: true,
            },
        }),
    );

    const docsEnabledFlag =
        (process.env.API_DOCS_ENABLED || '').toLowerCase() === 'true';
    const docsUser = process.env.API_DOCS_BASIC_USER ?? '';
    const docsPass = process.env.API_DOCS_BASIC_PASS ?? '';
    const basicEnabled = !!docsUser && !!docsPass;
    const docsEnabled = docsEnabledFlag && basicEnabled;
    if (docsEnabledFlag && !basicEnabled) {
        console.warn(
            'API_DOCS_BASIC_USER/API_DOCS_BASIC_PASS required to enable docs. Docs disabled.',
        );
    }
    if (docsEnabled) {
        const rawDocsPath = process.env.API_DOCS_PATH || '/docs';
        const rawDocsSpecPath =
            process.env.API_DOCS_SPEC_PATH || '/openapi.json';
        const docsPath = rawDocsPath.startsWith('/')
            ? rawDocsPath
            : `/${rawDocsPath}`;
        const docsSpecPath = rawDocsSpecPath.startsWith('/')
            ? rawDocsSpecPath
            : `/${rawDocsSpecPath}`;
        const fastify = app.getHttpAdapter().getInstance();
        fastify.addHook('onRequest', async (request, reply) => {
            const url = request.raw?.url || request.url || '';
            if (
                url === docsPath ||
                url.startsWith(`${docsPath}/`) ||
                url === docsSpecPath ||
                url.startsWith(`${docsSpecPath}/`)
            ) {
                const credentials = parseBasicAuth(
                    request.headers.authorization,
                );
                const ok = validateBasicAuth(credentials, {
                    user: docsUser,
                    pass: docsPass,
                });

                if (!ok) {
                    reply.header('WWW-Authenticate', 'Basic realm="docs"');
                    reply.status(401).send({
                        statusCode: 401,
                        message: 'Unauthorized',
                    });
                    return;
                }
            }
        });

        const configBuilder = new DocumentBuilder()
            .setTitle('Kodus MCP Manager')
            .setDescription('OpenAPI documentation for Kodus MCP Manager')
            .setVersion(process.env.npm_package_version || '0.0.1')
            .addBearerAuth()
            .addTag('Health', 'Service health and environment checks')
            .addTag('MCP', 'MCP connections and integrations')
            .build();

        const serverUrlsRaw = process.env.API_DOCS_SERVER_URLS || '';
        const baseUrl = process.env.API_DOCS_BASE_URL || '';
        const serverUrls = serverUrlsRaw
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);

        const document = SwaggerModule.createDocument(app, {
            ...configBuilder,
            servers: [
                ...(serverUrls.length > 0
                    ? serverUrls.map((url) => ({ url }))
                    : baseUrl
                      ? [{ url: baseUrl }]
                      : []),
            ],
        });

        SwaggerModule.setup(docsPath.replace(/^\//, ''), app, document, {
            swaggerOptions: {
                supportedSubmitMethods: [],
            },
        });

        fastify.get(docsSpecPath, async (_request, reply) => {
            reply.send(document);
        });
    }

    const port = process.env.API_MCP_MANAGER_PORT || 3101;
    await app.listen(port, '0.0.0.0');
    console.log(`Server is running on port ${port}`);
}

bootstrap();
