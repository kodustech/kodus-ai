// Load .env so API_PG_DB_* resolve to the values docker-compose.dev.yml
// expects; without it the probe fails and the suite skips instead of running.
require('dotenv').config();

jest.mock('@libs/mcp-server/mcp-adapter', () => ({
    createMCPAdapter: jest.fn(),
}));

import { DataSource } from 'typeorm';

import { McpService } from '../../src/modules/mcp/mcp.service';
import {
    MCPConnectionEntity,
    MCPConnectionStatus,
} from '../../src/modules/mcp/entities/mcp-connection.entity';
import { MCPIntegrationOAuthEntity } from '../../src/modules/integrations/entities/mcp-integration-oauth.entity';
import { MCPIntegrationOAuthStatus } from '../../src/modules/integrations/enums/integration.enum';

const PG = {
    host: process.env.TEST_PG_HOST ?? 'localhost',
    port: parseInt(
        process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? '5432',
        10,
    ),
    username:
        process.env.TEST_PG_USER ??
        process.env.API_PG_DB_USERNAME ??
        'kodusdev',
    password:
        process.env.TEST_PG_PASSWORD ??
        process.env.API_PG_DB_PASSWORD ??
        'kodusdev',
    database:
        process.env.TEST_PG_DB ?? process.env.API_PG_DB_DATABASE ?? 'kodus_db',
};
// A database of its own, so the "mcp-manager" schema the SQL names can be
// created and dropped without touching anyone's data.
const SCRATCH_DB = `mcp_expire_it_${process.pid}`;

const ORG = 'org-1';
const INT = 'linear-default';

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

// Production 2026-10-29 / #2314: a connection whose OAuth grant was lost is
// set to EXPIRED so the runtime stops listing it. A reconnect can save an
// ACTIVE grant between the manager's status read and that update; the update
// must then leave the reconnected connection ACTIVE. Checked against a real
// Postgres because the guarantee lives in the SQL (EXISTS in the same
// statement), not in the service code.
(skipIntegration ? describe.skip : describe)(
    "McpService — expiring a lost grant's connection (integration, real Postgres)",
    () => {
        let admin: DataSource;
        let ds: DataSource;
        let canRun = true;

        beforeAll(async () => {
            admin = new DataSource({ type: 'postgres', ...PG });
            try {
                await admin.initialize();
            } catch {
                canRun = false;
                return;
            }
            await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
            await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
            const bootstrap = new DataSource({
                type: 'postgres',
                ...PG,
                database: SCRATCH_DB,
            });
            await bootstrap.initialize();
            await bootstrap.query('CREATE SCHEMA "mcp-manager"');
            await bootstrap.destroy();
            ds = new DataSource({
                type: 'postgres',
                ...PG,
                database: SCRATCH_DB,
                entities: [MCPConnectionEntity, MCPIntegrationOAuthEntity],
                synchronize: true,
            });
            await ds.initialize();
        });

        afterAll(async () => {
            if (!canRun) return;
            await ds?.destroy();
            await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
            await admin.destroy();
        });

        const seed = async (grant: MCPIntegrationOAuthStatus) => {
            await ds.getRepository(MCPConnectionEntity).clear();
            await ds.getRepository(MCPIntegrationOAuthEntity).clear();
            await ds.getRepository(MCPIntegrationOAuthEntity).save({
                organizationId: ORG,
                integrationId: INT,
                status: grant,
            });
            await ds.getRepository(MCPConnectionEntity).save({
                organizationId: ORG,
                integrationId: INT,
                provider: 'kodusmcp',
                status: MCPConnectionStatus.ACTIVE,
                appName: 'Linear',
            });
        };

        // The manager read the grant as INACTIVE (and got no token) just
        // before; what the database holds now is what the update must honor.
        const expireAfterStaleRead = async () => {
            const service = new McpService(
                {} as any,
                ds.getRepository(MCPConnectionEntity),
                {} as any,
                {} as any,
                {
                    resolveManagedAuthHeaders: async () => ({}),
                    getOAuthStatus: async () =>
                        MCPIntegrationOAuthStatus.INACTIVE,
                } as any,
            );
            await service.getKodusMCPConnectionConfig(ORG, INT);
            const row = await ds
                .getRepository(MCPConnectionEntity)
                .findOneByOrFail({ organizationId: ORG, integrationId: INT });
            return row.status;
        };

        it('leaves the connection ACTIVE when the user reconnected after the read', async () => {
            if (!canRun) return;
            await seed(MCPIntegrationOAuthStatus.ACTIVE);

            expect(await expireAfterStaleRead()).toBe(
                MCPConnectionStatus.ACTIVE,
            );
        });

        it('expires the connection while the grant is still lost', async () => {
            if (!canRun) return;
            await seed(MCPIntegrationOAuthStatus.INACTIVE);

            expect(await expireAfterStaleRead()).toBe(
                MCPConnectionStatus.EXPIRED,
            );
        });
    },
);
