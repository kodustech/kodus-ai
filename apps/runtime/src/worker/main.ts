import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { loadWorkerConfig } from '../shared/config';
import { RuntimeLogger } from '../shared/logger';
import { setupRuntimeOtel } from '../shared/otel';
import { RuntimeWorkerModule } from './runtime-worker.module';

async function bootstrap() {
    // Fails here, before anything connects, on a missing seal key or a bad setting.
    const config = loadWorkerConfig();
    const logger = new RuntimeLogger('runtime-worker');
    const shutdownOtel = await setupRuntimeOtel('runtime-worker', config.metricsPort);
    const app = await NestFactory.createApplicationContext(RuntimeWorkerModule.forConfig(config), { logger });
    app.enableShutdownHooks();
    await app.init();
    logger.write('info', 'runtime-worker consuming workflow.jobs.runtime_run.queue');
    process.once('SIGTERM', () => void shutdownOtel());
}

void bootstrap();
