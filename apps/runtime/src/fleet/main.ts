import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { loadFleetConfig } from '../shared/config';
import { RuntimeLogger } from '../shared/observability/logger';
import { setupRuntimeOtel } from '../shared/observability/otel';
import { RuntimeFleetModule } from './runtime-fleet.module';

async function bootstrap() {
    // Fails here, before anything connects, on a missing seal key, installation or hub URL.
    const config = loadFleetConfig();
    const logger = new RuntimeLogger('runtime-fleet');
    const shutdownOtel = await setupRuntimeOtel({ serviceName: 'runtime-fleet', serviceVersion: config.releaseVersion }, config.metricsPort);
    const app = await NestFactory.createApplicationContext(RuntimeFleetModule.forConfig(config), { logger });
    app.enableShutdownHooks();
    await app.init();
    process.once('SIGTERM', () => void shutdownOtel());
}

void bootstrap();
