/**
 * INTEGRATION — the identity of a stored git credential, against Postgres.
 *
 * The GitHub content rate-limit gate keys a token credential (PAT) by its
 * auth_integrations row id plus the row's last write, so nothing derived from
 * the token is used. That only works if, on the real schema:
 *   1. getPlatformAuthDetails returns the row id and `updatedAt` (they travel
 *      on the `authIntegration` relation, which the domain type did not
 *      declare before);
 *   2. updating the token through AuthIntegrationRepository.update (the
 *      QueryBuilder path the PAT flow uses) moves `updatedAt`, so the gate
 *      key changes when the token is rotated.
 * A mock cannot prove either. Synthetic rows only, removed afterwards.
 *
 * Skips automatically if Postgres isn't reachable, matching the pattern in
 * test/integration/parameters/create-or-update-config-race.integration.spec.ts.
 */
require('dotenv').config();

import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { sleep } from '@libs/common/utils/helpers';
import { ENTITIES } from '@libs/core/infrastructure/database/typeorm/entities';
import { AuthIntegrationRepository } from '@libs/integrations/infrastructure/adapters/repositories/authIntegration.repository';
import { IntegrationRepository } from '@libs/integrations/infrastructure/adapters/repositories/integration.repository';
import { AuthIntegrationModel } from '@libs/integrations/infrastructure/adapters/repositories/schemas/authIntegration.model';
import { IntegrationModel } from '@libs/integrations/infrastructure/adapters/repositories/schemas/integration.model';
import { IntegrationService } from '@libs/integrations/infrastructure/adapters/services/integration.service';
import { contentRateLimitKey } from '@libs/platform/infrastructure/adapters/services/github/content-rate-limit-gate';

const PG_HOST = process.env.TEST_PG_HOST ?? 'localhost';
const PG_PORT = parseInt(
    process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? '5432',
    10,
);
const PG_USER =
    process.env.TEST_PG_USER ?? process.env.API_PG_DB_USERNAME ?? 'kodusdev';
const PG_PASSWORD =
    process.env.TEST_PG_PASSWORD ??
    process.env.API_PG_DB_PASSWORD ??
    'kodusdev';
const PG_DB =
    process.env.TEST_PG_DB ?? process.env.API_PG_DB_DATABASE ?? 'kodus_db';

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

const makeDataSource = () =>
    new DataSource({
        type: 'postgres',
        host: PG_HOST,
        port: PG_PORT,
        username: PG_USER,
        password: PG_PASSWORD,
        database: PG_DB,
        logging: false,
        synchronize: false,
        entities: ENTITIES,
        extra: { max: 2, min: 1, connectionTimeoutMillis: 10_000 },
    });

async function isPostgresReachable(): Promise<boolean> {
    const probe = makeDataSource();
    try {
        await probe.initialize();
        await probe.query('SELECT 1 FROM auth_integrations LIMIT 1');
        return true;
    } catch (error) {
        if (process.env.TEST_PG_HOST) {
            // Named on purpose: surface why, instead of a silent skip.
            console.error('Postgres not reachable:', (error as Error)?.message);
        }
        return false;
    } finally {
        if (probe.isInitialized) {
            await probe.destroy();
        }
    }
}

describe('auth integration identity (real Postgres)', () => {
    let dataSource: DataSource;
    let reachable = false;
    let authRepository: AuthIntegrationRepository;
    let integrationService: IntegrationService;

    const orgId = uuidv4();
    const teamId = uuidv4();
    const integrationId = uuidv4();
    let authId: string;
    const tenant = { organizationId: orgId, teamId };

    beforeAll(async () => {
        if (skipIntegration) return;
        reachable = await isPostgresReachable();
        if (!reachable) return;

        dataSource = makeDataSource();
        await dataSource.initialize();

        authRepository = new AuthIntegrationRepository(
            dataSource.getRepository(AuthIntegrationModel),
        );
        integrationService = new IntegrationService(
            new IntegrationRepository(
                dataSource.getRepository(IntegrationModel),
            ),
            {} as any,
        );

        await dataSource.query(
            `INSERT INTO organizations (uuid, name) VALUES ($1, $2)`,
            [orgId, `test-org-${orgId}`],
        );
        await dataSource.query(
            `INSERT INTO teams (uuid, name, organization_id) VALUES ($1, $2, $3)`,
            [teamId, `test-team-${teamId}`, orgId],
        );

        const auth = await authRepository.create({
            status: true,
            authDetails: {
                authMode: 'token',
                authToken: 'encrypted-token-v1',
                org: 'acme',
            },
            organization: { uuid: orgId },
            team: { uuid: teamId },
        } as any);
        authId = auth.uuid;

        await dataSource.query(
            `INSERT INTO integrations
                (uuid, status, platform, "integrationCategory", organization_id, team_id, auth_integration_id)
             VALUES ($1, true, 'GITHUB', 'CODE_MANAGEMENT', $2, $3, $4)`,
            [integrationId, orgId, teamId, authId],
        );
    });

    afterAll(async () => {
        if (!dataSource?.isInitialized) return;
        await dataSource.query(`DELETE FROM integrations WHERE uuid = $1`, [
            integrationId,
        ]);
        if (authId) {
            await dataSource.query(
                `DELETE FROM auth_integrations WHERE uuid = $1`,
                [authId],
            );
        }
        await dataSource.query(`DELETE FROM teams WHERE uuid = $1`, [teamId]);
        await dataSource.query(`DELETE FROM organizations WHERE uuid = $1`, [
            orgId,
        ]);
        await dataSource.destroy();
    });

    const readAuth = () =>
        integrationService.getPlatformAuthDetails<any>(
            tenant,
            PlatformType.GITHUB,
        );

    // The skip-when-unreachable pattern would let every case below pass
    // without running. When a database was named on purpose, not reaching it
    // is a failure, not a skip.
    it('reaches the database it was pointed at', () => {
        if (skipIntegration || !process.env.TEST_PG_HOST) return;
        expect(reachable).toBe(true);
    });

    it('returns the row id and last write alongside the stored auth details', async () => {
        if (!reachable) return;

        const auth = await readAuth();

        expect(auth.integrationId).toBe(integrationId);
        expect(auth.authToken).toBe('encrypted-token-v1');
        expect(auth.authIntegrationId).toBe(authId);
        expect(auth.authUpdatedAt).toBeInstanceOf(Date);
    });

    it('moves updatedAt when the token is updated, so the gate key changes', async () => {
        if (!reachable) return;

        const before = await readAuth();
        const keyBefore = contentRateLimitKey(tenant, before);

        await sleep(20);
        await authRepository.update(
            { uuid: authId },
            {
                authDetails: {
                    authMode: 'token',
                    authToken: 'encrypted-token-v2',
                    org: 'acme',
                },
            },
        );

        const after = await readAuth();
        expect(after.authToken).toBe('encrypted-token-v2');
        expect(after.authIntegrationId).toBe(authId);
        expect(new Date(after.authUpdatedAt).getTime()).toBeGreaterThan(
            new Date(before.authUpdatedAt).getTime(),
        );
        expect(contentRateLimitKey(tenant, after)).not.toBe(keyBefore);
    });

    it('keeps the key stable while the row is untouched', async () => {
        if (!reachable) return;

        const first = await readAuth();
        const second = await readAuth();

        expect(contentRateLimitKey(tenant, second)).toBe(
            contentRateLimitKey(tenant, first),
        );
    });

    it('never builds the key from the token', async () => {
        if (!reachable) return;

        const auth = await readAuth();
        const key = contentRateLimitKey(tenant, auth);

        expect(key).toContain(authId);
        expect(key).not.toContain(auth.authToken);
    });
});
