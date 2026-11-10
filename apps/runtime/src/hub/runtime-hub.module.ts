import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

import { FileRunStreamStore } from '@libs/runtime/run/adapters/file-run-stream.store';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { loadRuntimeConfig, RUNTIME_CONFIG, RUNTIME_PG_POOL, RuntimeConfig } from '../shared/config';
import { pgTransaction } from '../shared/cell-directory';
import { PgAdmissionStore } from '../shared/pg-admission-store';
import { PgPhysicalAdmissionDirectory } from '../shared/physical-admission-directory';
import { WorkerAuthGuard } from '../shared/internal-auth.guard';
import { RuntimeLogger } from '../shared/logger';
import { PgRunStreamStore } from '../shared/pg-run-stream-store';
import { ensureDatabase, ensureRuntimeSchema } from '../shared/runtime-schema';
import { createCa } from './ca/x509';
import { CellGatewayService } from './cell-gateway.service';
import { CellHub } from './cell-hub';
import { CELL_CERT_HOURS } from './enrollment/cell-identity.service';
import { PgHubStore } from './hub-store';
import { InternalController } from './http/internal.controller';
import { PublicCellController } from './http/public-cell.controller';
import { TraceContextInterceptor } from './http/trace-context.interceptor';

/** The CA from config; an ephemeral one only in the test-only plaintext mode (no cell can then use mTLS). */
function hubCa(c: RuntimeConfig) {
    if (c.tls?.caKey) return { certPem: c.tls.ca, keyPem: c.tls.caKey };
    if (c.testOnlyPlaintext) return createCa('ephemeral test CA');
    throw new Error('RUNTIME_TLS_CA and RUNTIME_TLS_CA_KEY are required (or RUNTIME_TEST_ONLY_PLAINTEXT=1 in tests)');
}

export const HUB_LOGGER = Symbol('HUB_LOGGER');

@Module({
    controllers: [PublicCellController, InternalController],
    providers: [
        { provide: RUNTIME_CONFIG, useFactory: () => loadRuntimeConfig() },
        { provide: HUB_LOGGER, useFactory: () => new RuntimeLogger('runtime-hub') },
        {
            provide: RUNTIME_PG_POOL,
            inject: [RUNTIME_CONFIG],
            useFactory: async (c: RuntimeConfig) => {
                await ensureDatabase(c.databaseUrl);
                const pool = new Pool({ connectionString: c.databaseUrl, max: 10, ...(c.durableAdmission ? { connectionTimeoutMillis: 5000 } : {}) });
                await ensureRuntimeSchema(pool);
                return pool;
            },
        },
        {
            provide: CellHub,
            inject: [RUNTIME_CONFIG, RUNTIME_PG_POOL, HUB_LOGGER],
            useFactory: async (c: RuntimeConfig, pool: Pool, logger: RuntimeLogger) => {
                const streams = c.streamStore === 'postgres' ? new PgRunStreamStore(pool) : new FileRunStreamStore(c.streamDir);
                const hub = new CellHub(new PgHubStore(pool), streams, new RuntimeMetrics(), {
                    replicaId: c.replicaId,
                    replicaUrl: c.replicaUrl,
                    ca: hubCa(c),
                    allowInsecureCells: c.allowInsecureCells,
                    logger: logger.child('CellHub'),
                    ...(c.durableAdmission ? { admission: {
                        ownership: new PgAdmissionStore(pool),
                        directory: new PgPhysicalAdmissionDirectory(pool, { sharedClaimCap: c.orgSharedClaimCap, inTransaction: pgTransaction(pool) }),
                    } } : {}),
                });
                if (c.allowInsecureCells) logger.write('warn', 'RUNTIME_DEV_ALLOW_INSECURE_CELLS=1: cells with isolation none are accepted. Never in production.');
                // Managed certificates from the CA are short; the row's expiry is the CA's own bound (24 h after boot, renewed by the cell).
                await hub.ensureManagedCells(c.managedCells, new Date(Date.now() + CELL_CERT_HOURS * 3_600_000).toISOString());
                // Pins and revoked serials are in memory before the port opens: until then handshakeAllowed refuses every certificate.
                await hub.refreshPins();
                return hub;
            },
        },
        WorkerAuthGuard,
        TraceContextInterceptor,
        CellGatewayService,
    ],
})
export class RuntimeHubModule implements OnApplicationShutdown {
    constructor(@Inject(RUNTIME_PG_POOL) private readonly pool: Pool) {}

    async onApplicationShutdown() {
        await this.pool.end().catch(() => undefined);
    }
}
