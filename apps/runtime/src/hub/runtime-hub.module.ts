import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

import { FileRunStreamStore } from '@libs/runtime/run/adapters/file-run-stream.store';
import { RuntimeMetrics } from '@libs/runtime/telemetry';

import { loadRuntimeConfig, RUNTIME_CONFIG, RUNTIME_PG_POOL, RuntimeConfig } from '../shared/config';
import { pgTransaction } from '../shared/persistence/cell-directory';
import { PgHostPoolReader } from '../shared/persistence/host-pools';
import { PgAdmissionStore } from '../shared/admission/pg-admission-store';
import { PgPhysicalAdmissionDirectory } from '../shared/admission/physical-admission-directory';
import { FleetAuthGuard, WorkerAuthGuard } from '../shared/identity/internal-auth.guard';
import { RuntimeLogger } from '../shared/observability/logger';
import { PgRunStreamStore } from '@libs/runtime/run/adapters/pg-run-stream.store';
import { ensureDatabase, ensureRuntimeSchema } from '../shared/persistence/runtime-schema';
import { createCa } from './ca/x509';
import { CellGatewayService } from './cell-gateway.service';
import { PgPreviewStore } from '../shared/persistence/preview-store';
import { CellHub } from './cell-hub';
import { CELL_CERT_HOURS } from './enrollment/cell-identity.service';
import { PgHubStore } from './hub-store';
import { InternalController } from './http/internal.controller';
import { FleetInternalController } from './http/fleet.controller';
import { FleetEnrollment } from './enrollment/fleet-enrollment';
import { PgFleetTokenStore } from './enrollment/pg-fleet-token.store';
import { FleetTokenLedger } from '@libs/runtime/contracts/fleet-token';
import { PublicCellController } from './http/public-cell.controller';
import { TraceContextInterceptor } from './http/trace-context.interceptor';
import { PgMachineMinuteStore } from './claims/pg-machine-minutes.store';
import { PgOrgSecretRefs } from './claims/org-secret-refs';

/** The product Postgres the org secrets' references are read from (names and hosts only), when configured. */
export const PRODUCT_SECRETS_POOL = Symbol('PRODUCT_SECRETS_POOL');

/** The CA from config; an ephemeral one only in the test-only plaintext mode (no cell can then use mTLS). */
function hubCa(c: RuntimeConfig) {
    if (c.tls?.caKey) return { certPem: c.tls.ca, keyPem: c.tls.caKey };
    if (c.testOnlyPlaintext) return createCa('ephemeral test CA');
    throw new Error('RUNTIME_TLS_CA and RUNTIME_TLS_CA_KEY are required (or RUNTIME_TEST_ONLY_PLAINTEXT=1 in tests)');
}

export const HUB_LOGGER = Symbol('HUB_LOGGER');

@Module({
    controllers: [PublicCellController, InternalController, FleetInternalController],
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
            provide: PRODUCT_SECRETS_POOL,
            inject: [RUNTIME_CONFIG],
            useFactory: (c: RuntimeConfig) => (c.productSecretsReadUrl ? new Pool({ connectionString: c.productSecretsReadUrl, max: 2, connectionTimeoutMillis: 5000 }) : null),
        },
        {
            provide: CellHub,
            inject: [RUNTIME_CONFIG, RUNTIME_PG_POOL, HUB_LOGGER, PRODUCT_SECRETS_POOL],
            useFactory: async (c: RuntimeConfig, pool: Pool, logger: RuntimeLogger, secretsPool: Pool | null) => {
                const streams = c.streamStore === 'postgres' ? new PgRunStreamStore(pool) : new FileRunStreamStore(c.streamDir);
                const hub = new CellHub(new PgHubStore(pool), streams, new RuntimeMetrics(), {
                    replicaId: c.replicaId,
                    replicaUrl: c.replicaUrl,
                    ca: hubCa(c),
                    allowInsecureCells: c.allowInsecureCells,
                    logger: logger.child('CellHub'),
                    machineMinutes: { store: new PgMachineMinuteStore(pool), limitMinutes: c.machineMinutesPerOrgDay },
                    sandboxMemoryMb: c.sandboxMemoryMb,
                    ...(c.previewTunnelUrl ? { preview: { tunnelUrl: c.previewTunnelUrl, tickets: new PgPreviewStore(pool) } } : {}),
                    ...(secretsPool ? { secrets: new PgOrgSecretRefs(secretsPool) } : {}),
                    ...(c.durableAdmission ? { admission: {
                        ownership: new PgAdmissionStore(pool),
                        directory: new PgPhysicalAdmissionDirectory(pool, { sharedClaimCap: c.orgSharedClaimCap, inTransaction: pgTransaction(pool), pools: new PgHostPoolReader(pool) }),
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
        {
            // runtime-fleet's door to cell identity (docs/runtime/host-providers.md §8.1); FleetAuthGuard admits only its CN.
            provide: FleetEnrollment,
            inject: [RUNTIME_PG_POOL, HUB_LOGGER, CellHub],
            useFactory: (pool: Pool, logger: RuntimeLogger, hub: CellHub) =>
                new FleetEnrollment(new PgHubStore(pool), new FleetTokenLedger(new PgFleetTokenStore(pool)), (level, msg, fields) => logger.write(level, msg, fields), hub.connections),
        },
        WorkerAuthGuard,
        FleetAuthGuard,
        TraceContextInterceptor,
        CellGatewayService,
    ],
})
export class RuntimeHubModule implements OnApplicationShutdown {
    constructor(
        @Inject(RUNTIME_PG_POOL) private readonly pool: Pool,
        @Inject(PRODUCT_SECRETS_POOL) private readonly secretsPool: Pool | null,
    ) {}

    async onApplicationShutdown() {
        // Pool end on shutdown: a connection that fails to close goes with the process, and the second pool still ends.
        await this.pool.end().catch(() => undefined);
        await this.secretsPool?.end().catch(() => undefined);
    }
}
