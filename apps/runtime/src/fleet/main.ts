import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';

import { loadFleetApplyConfig, loadFleetConfig } from '../shared/config';
import { RuntimeLogger } from '../shared/observability/logger';
import { setupRuntimeOtel } from '../shared/observability/otel';
import { ensureRuntimeSchema } from '../shared/persistence/runtime-schema';
import { runFleetCommand } from './fleet-command';
import { PgPoolSpecWriter } from './pool-apply';
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

/** `runtime-fleet apply -f <dir>` (§5.2): writes pool specs and exits; it starts no loop and holds no provider key. */
async function command(argv: string[]) {
    const config = loadFleetApplyConfig();
    const code = await runFleetCommand(argv, {
        writer: async () => {
            const pool = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
            await ensureRuntimeSchema(pool);
            return new PgPoolSpecWriter(pool);
        },
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
        allowFake: config.allowFake,
    });
    process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.length) void command(argv);
else void bootstrap();
