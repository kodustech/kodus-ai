/**
 * INTEGRATION TEST: ConnectionAccessService.replaceGrants against a real
 * Postgres, reading the stored grants back. Skips when Postgres is not
 * reachable, like the other *.integration.spec.ts files.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import {
    connectTestPostgres,
    disconnectTestPostgres,
    skipPostgresIntegration,
} from '../../../../../../test/helpers/postgres-integration';
import { UserConnectionAccessRepository } from '@libs/identity/infrastructure/adapters/repositories/userConnectionAccess.repository';

import { ConnectionAccessService } from './connection-access.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

(skipPostgresIntegration ? describe.skip : describe)(
    'ConnectionAccessService.replaceGrants (integration, real Postgres)',
    () => {
        let ds: DataSource | undefined;
        let service: ConnectionAccessService;
        const connection = randomUUID();
        const other = randomUUID();
        const [u1, u2, u3] = [randomUUID(), randomUUID(), randomUUID()];

        const stored = async (integrationId: string) =>
            (
                (await ds!.query(
                    `SELECT "user_id" FROM "user_connection_access"
                      WHERE "integration_id" = $1 ORDER BY "user_id"`,
                    [integrationId],
                )) as Array<{ user_id: string }>
            ).map((row) => row.user_id);

        beforeAll(async () => {
            ds = await connectTestPostgres({ replica: true });
            if (!ds) return;
            service = new ConnectionAccessService(
                new UserConnectionAccessRepository({
                    manager: ds.manager,
                } as any),
            );
        });

        afterAll(async () => {
            if (!ds) return;
            await ds.query(
                `DELETE FROM "user_connection_access" WHERE "integration_id" = ANY($1::uuid[])`,
                [[connection, other]],
            );
            await disconnectTestPostgres(ds);
        });

        it('stores exactly the target set, leaving other connections alone', async () => {
            if (!ds) return;
            await ds.query(
                `INSERT INTO "user_connection_access" ("user_id", "integration_id")
                 VALUES ($1, $3), ($2, $3), ($1, $4)`,
                [u1, u2, connection, other],
            );

            const diff = await service.replaceGrants(connection, [u2, u3]);

            expect(diff).toEqual({ granted: [u3], revoked: [u1] });
            expect(await stored(connection)).toEqual([u2, u3].sort());
            expect(await stored(other)).toEqual([u1]);
        });

        it('revokes everyone with an empty set, and repeats idempotently', async () => {
            if (!ds) return;

            await service.replaceGrants(connection, [u3]);
            await service.replaceGrants(connection, [u3]);
            expect(await stored(connection)).toEqual([u3]);

            await service.replaceGrants(connection, []);
            expect(await stored(connection)).toEqual([]);
        });
    },
);
