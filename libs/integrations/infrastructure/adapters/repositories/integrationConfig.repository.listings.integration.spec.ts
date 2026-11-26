/**
 * INTEGRATION TEST: IntegrationConfigRepository.findRepositoryListings
 * against a real Postgres. Skips when Postgres is not reachable.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import {
    connectTestPostgres,
    disconnectTestPostgres,
    skipPostgresIntegration,
} from '../../../../../test/helpers/postgres-integration';
import { IntegrationConfigRepository } from './integrationConfig.repository';

(skipPostgresIntegration ? describe.skip : describe)(
    'IntegrationConfigRepository.findRepositoryListings (integration, real Postgres)',
    () => {
        let ds: DataSource | undefined;
        let repository: IntegrationConfigRepository;
        const team = randomUUID();
        const otherTeam = randomUUID();
        const [cloud, acme, beta] = [randomUUID(), randomUUID(), randomUUID()];
        const rows: string[] = [];

        const list = async (
            teamId: string,
            integrationId: string,
            value: unknown,
        ) => {
            const uuid = randomUUID();
            rows.push(uuid);
            await ds!.query(
                `INSERT INTO "integration_configs" ("uuid", "configKey", "configValue", "integration_id", "team_id")
                 VALUES ($1, 'repositories', $2::jsonb, $3, $4)`,
                [uuid, JSON.stringify(value), integrationId, teamId],
            );
        };

        beforeAll(async () => {
            ds = await connectTestPostgres({ replica: true });
            if (!ds) return;
            repository = new IntegrationConfigRepository({
                manager: ds.manager,
            } as any);
            await list(team, cloud, [
                { id: '42', name: 'tools/api' },
                { id: 7, name: 'web', full_name: 'Tools/Web' },
            ]);
            await list(team, acme, [
                { id: '42', name: 'api', organizationName: 'acme' },
            ]);
            await list(team, beta, { not: 'a list' });
            await list(otherTeam, beta, [{ id: '42', name: 'api' }]);
        });

        afterAll(async () => {
            if (!ds) return;
            await ds.query(
                `DELETE FROM "integration_configs" WHERE "uuid" = ANY($1::uuid[])`,
                [rows],
            );
            await disconnectTestPostgres(ds);
        });

        const find = (
            integrationIds: string[],
            hint: { id?: string | number; name?: string; fullName?: string },
            teamId = team,
        ) =>
            repository.findRepositoryListings({
                teamId,
                integrationIds,
                repository: hint,
            });

        it("returns each listing connection's matching entry, by id", async () => {
            if (!ds) return;
            const found = await find([cloud, acme, beta], { id: 42 });
            expect(
                found.map((listing) => listing.integrationId).sort(),
            ).toEqual([cloud, acme].sort());
            expect(
                found.find((listing) => listing.integrationId === acme)
                    ?.repository,
            ).toEqual({ id: '42', name: 'api', organizationName: 'acme' });
        });

        it('matches a numeric stored id', async () => {
            if (!ds) return;
            const found = await find([cloud, acme], { id: '7' });
            expect(found.map((listing) => listing.integrationId)).toEqual([
                cloud,
            ]);
        });

        it('matches a full name in any stored form, ignoring case', async () => {
            if (!ds) return;
            expect(
                (await find([cloud, acme], { fullName: 'ACME/api' })).map(
                    (listing) => listing.integrationId,
                ),
            ).toEqual([acme]);
            expect(
                (await find([cloud, acme], { fullName: 'tools/web' })).map(
                    (listing) => listing.integrationId,
                ),
            ).toEqual([cloud]);
            expect(
                (await find([cloud, acme], { fullName: 'tools/api' })).map(
                    (listing) => listing.integrationId,
                ),
            ).toEqual([cloud]);
        });

        it("reads only the team's lists of the given connections", async () => {
            if (!ds) return;
            expect(await find([beta], { id: '42' })).toEqual([]);
            expect(
                (await find([beta], { id: '42' }, otherTeam)).map(
                    (listing) => listing.integrationId,
                ),
            ).toEqual([beta]);
        });

        it('answers nothing without a team, connections or a hint', async () => {
            if (!ds) return;
            expect(await find([cloud], {}, team)).toEqual([]);
            expect(await find([], { id: '42' })).toEqual([]);
            expect(await find([cloud], { id: '42' }, '')).toEqual([]);
        });
    },
);

(skipPostgresIntegration ? describe.skip : describe)(
    'IntegrationConfigRepository.findRepositoryListsOfOrganization (integration, real Postgres)',
    () => {
        let ds: DataSource | undefined;
        let repository: IntegrationConfigRepository;
        const organizationId = randomUUID();
        const [active, inactive] = [randomUUID(), randomUUID()];
        const [auth, configA, configB] = [
            randomUUID(),
            randomUUID(),
            randomUUID(),
        ];

        beforeAll(async () => {
            ds = await connectTestPostgres({ replica: true });
            if (!ds) return;
            repository = new IntegrationConfigRepository({
                manager: ds.manager,
            } as any);
            await ds.query(
                `INSERT INTO "auth_integrations" ("uuid", "status", "authDetails")
                 VALUES ($1, true, $2::jsonb)`,
                [
                    auth,
                    JSON.stringify({ host: 'https://git.acme.io', token: 'x' }),
                ],
            );
            await ds.query(
                `INSERT INTO "integrations" ("uuid", "status", "platform", "integrationCategory", "organization_id", "auth_integration_id")
                 VALUES ($1, true, 'GITLAB', 'CODE_MANAGEMENT', $3, $4),
                        ($2, false, 'GITLAB', 'CODE_MANAGEMENT', $3, NULL)`,
                [active, inactive, organizationId, auth],
            );
            await ds.query(
                `INSERT INTO "integration_configs" ("uuid", "configKey", "configValue", "integration_id", "team_id")
                 VALUES ($1, 'repositories', '[{"id": 42}]'::jsonb, $3, $5),
                        ($2, 'repositories', '[{"id": 7}]'::jsonb, $4, $5)`,
                [configA, configB, active, inactive, randomUUID()],
            );
        });

        afterAll(async () => {
            if (!ds) return;
            await ds.query(
                `DELETE FROM "integration_configs" WHERE "uuid" = ANY($1::uuid[])`,
                [[configA, configB]],
            );
            await ds.query(
                `DELETE FROM "integrations" WHERE "uuid" = ANY($1::uuid[])`,
                [[active, inactive]],
            );
            await ds.query(
                `DELETE FROM "auth_integrations" WHERE "uuid" = $1`,
                [auth],
            );
            await disconnectTestPostgres(ds);
        });

        it("lists each active connection's repositories with its platform and host only", async () => {
            if (!ds) return;

            expect(
                await repository.findRepositoryListsOfOrganization(
                    organizationId,
                ),
            ).toEqual([
                {
                    integrationId: active,
                    platform: 'GITLAB',
                    host: 'https://git.acme.io',
                    repositories: [{ id: 42 }],
                },
            ]);
        });
    },
);
