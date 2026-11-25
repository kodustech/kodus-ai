/**
 * INTEGRATION TEST: ConnectionAccessService.replaceGrants against a real
 * Postgres, reading the stored grants back. Skips when Postgres is not
 * reachable, like the other *.integration.spec.ts files.
 */
require('dotenv').config();

import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import { ConnectionAccessService } from './connection-access.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const dataSource = () =>
    new DataSource({
        type: 'postgres',
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
            process.env.TEST_PG_DB ??
            process.env.API_PG_DB_DATABASE ??
            'kodus_db',
        logging: false,
        synchronize: false,
        entities: [],
        // One connection: the session setting below covers every query.
        extra: { max: 1, min: 1, connectionTimeoutMillis: 10_000 },
    });

/** Postgres not running or not reachable: skip. Anything else must fail. */
const UNREACHABLE = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
]);

const isUnreachable = (error: unknown): boolean => {
    const { code, message, errors } = (error ?? {}) as {
        code?: string;
        message?: string;
        errors?: unknown[];
    };
    if (code && UNREACHABLE.has(code)) return true;
    // Node reports a refused dual-stack connect as an AggregateError.
    if (Array.isArray(errors) && errors.some(isUnreachable)) return true;
    // pg's own connect timeout and dropped-connection errors carry no code.
    return (
        !code && /timeout expired|Connection terminated/i.test(message ?? '')
    );
};

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

(skipIntegration ? describe.skip : describe)(
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
            const candidate = dataSource();
            try {
                await candidate.initialize();
            } catch (error) {
                await candidate.destroy().catch(() => undefined);
                if (!isUnreachable(error)) throw error;
                return;
            }
            // The rows reference throwaway users and connections.
            await candidate.query(`SET session_replication_role = replica`);
            ds = candidate;
            service = new ConnectionAccessService({
                manager: ds.manager,
            } as any);
        });

        afterAll(async () => {
            if (!ds) return;
            await ds.query(
                `DELETE FROM "user_connection_access" WHERE "integration_id" = ANY($1::uuid[])`,
                [[connection, other]],
            );
            await ds.query(`SET session_replication_role = DEFAULT`);
            await ds.destroy();
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
