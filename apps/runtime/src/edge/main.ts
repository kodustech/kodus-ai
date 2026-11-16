import 'reflect-metadata';

import { loadPreviewEdgeConfig } from '../shared/config';
import { RuntimeLogger } from '../shared/observability/logger';
import { setupRuntimeOtel } from '../shared/observability/otel';
import { startPreviewEdge } from './edge-app';

async function bootstrap() {
    const config = loadPreviewEdgeConfig();
    const logger = new RuntimeLogger('runtime-preview-edge');
    const shutdownOtel = await setupRuntimeOtel({ serviceName: 'runtime-preview-edge', serviceInstanceId: config.replicaId }, config.metricsPort);
    const listeners = await startPreviewEdge(config, (level, msg, fields) => logger.write(level, msg, fields));
    logger.write('info', 'runtime-preview-edge listening', {
        replicaId: config.replicaId,
        browserPort: config.port,
        tunnelPort: config.tunnelPort,
        browserTls: config.tls ? 'edge' : 'upstream',
    });
    process.once('SIGTERM', () => void listeners.close().then(shutdownOtel));
}

void bootstrap();
