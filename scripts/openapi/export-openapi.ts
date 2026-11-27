import 'source-map-support/register';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import axios from 'axios';
import { promises as fs } from 'fs';
import * as path from 'path';

import { ApiModule } from '../../apps/api/src/api.module';
import { buildDocsConfig } from '../../apps/api/src/docs/docs-guard';
import { ApiErrorDto } from '../../apps/api/src/dtos/api-error.dto';
import { NEST_APP_OPTIONS } from '@libs/core/infrastructure/nest/nest-app-options';

const resolveDocsAuth = () => {
    const username = process.env.API_DOCS_BASIC_USER;
    const password = process.env.API_DOCS_BASIC_PASS;

    if (username && password) {
        return { username, password };
    }

    return null;
};

const resolveDocsSpecUrl = () => {
    const baseUrl = process.env.API_DOCS_BASE_URL;
    if (!baseUrl) {
        return null;
    }

    const specPath = process.env.API_DOCS_SPEC_PATH || '/openapi.json';
    return new URL(specPath, baseUrl).toString();
};

async function exportFromUrl(sourceUrl: string) {
    const auth = resolveDocsAuth();
    const response = await axios.get(sourceUrl, {
        headers: { Accept: 'application/json' },
        ...(auth ? { auth } : {}),
    });
    return response.data;
}

async function exportOpenApi(): Promise<void> {
    const outputPath =
        process.env.OPENAPI_OUTPUT ||
        path.resolve(process.cwd(), 'docs', 'openapi.json');

    const specUrl = resolveDocsSpecUrl();
    if (specUrl) {
        const document = await exportFromUrl(specUrl);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(
            outputPath,
            JSON.stringify(document, null, 2),
            'utf8',
        );
        // eslint-disable-next-line no-console
        console.log(`OpenAPI exported to ${outputPath}`);
        return;
    }

    const app = await NestFactory.create(ApiModule, {
        ...NEST_APP_OPTIONS,
        logger: ['error'],
        abortOnError: false,
    });

    const docsConfig = buildDocsConfig(process.env);
    const swaggerBuilder = new DocumentBuilder()
        .setTitle('Kodus API')
        .setVersion('1.0')
        .addBearerAuth(
            {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
            },
            'jwt',
        );

    docsConfig.servers.forEach((server) => {
        swaggerBuilder.addServer(server.url, server.description);
    });

    const document = SwaggerModule.createDocument(app, swaggerBuilder.build(), {
        extraModels: [ApiErrorDto],
    });

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(document, null, 2), 'utf8');

    await app.close();
    // eslint-disable-next-line no-console
    console.log(`OpenAPI exported to ${outputPath}`);
}

exportOpenApi().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Failed to export OpenAPI:', error);
    process.exit(1);
});
