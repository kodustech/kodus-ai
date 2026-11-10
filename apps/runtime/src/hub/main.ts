import 'reflect-metadata';

import { loadRuntimeConfig } from '../shared/config';
import { RuntimeLogger } from '../shared/logger';
import { setupRuntimeOtel } from '../shared/otel';
import { createRuntimeHubApp, listenRuntimeHub } from './hub-app';

async function bootstrap() {
    const config = loadRuntimeConfig();
    const logger = new RuntimeLogger('runtime-hub');
    const shutdownOtel = await setupRuntimeOtel('runtime-hub', config.metricsPort);
    const { app, mtls } = await createRuntimeHubApp(config, logger);
    app.enableShutdownHooks();
    const listeners = await listenRuntimeHub(app, config);
    logger.write('info', 'runtime-hub listening', {
        replicaId: config.replicaId,
        publicPort: config.hubPort,
        internalPort: config.internalPort,
        transport: mtls ? 'mTLS' : 'PLAINTEXT test mode',
    });
    process.once('SIGTERM', () => void listeners.close().then(shutdownOtel));
}

void bootstrap();
