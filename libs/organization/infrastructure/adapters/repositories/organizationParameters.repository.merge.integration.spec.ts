/**
 * INTEGRATION TEST: OrganizationParametersRepository.mergeConfigValue
 * against a real Postgres. Skips when Postgres is not reachable.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import { OrganizationParametersKey } from '@libs/core/domain/enums/organization-parameters-key.enum';

import {
    connectTestPostgres,
    disconnectTestPostgres,
    skipPostgresIntegration,
} from '../../../../../test/helpers/postgres-integration';
import { OrganizationParametersRepository } from './organizationParameters.repository';

const KEY = OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT;

(skipPostgresIntegration ? describe.skip : describe)(
    'OrganizationParametersRepository.mergeConfigValue (integration, real Postgres)',
    () => {
        let ds: DataSource | undefined;
        let repository: OrganizationParametersRepository;
        const organizations: string[] = [];

        const stored = async (organizationId: string) =>
            (
                (await ds!.query(
                    `SELECT "configValue" FROM "organization_parameters"
                      WHERE "organization_id" = $1 AND "configKey" = $2`,
                    [organizationId, KEY],
                )) as Array<{ configValue: unknown }>
            ).map((row) => row.configValue);

        const organizationWith = async (configValue?: unknown) => {
            const organizationId = randomUUID();
            organizations.push(organizationId);
            if (configValue !== undefined) {
                await ds!.query(
                    `INSERT INTO "organization_parameters" ("uuid", "configKey", "configValue", "organization_id")
                     VALUES ($1, $2, $3::jsonb, $4)`,
                    [
                        randomUUID(),
                        KEY,
                        JSON.stringify(configValue),
                        organizationId,
                    ],
                );
            }
            return organizationId;
        };

        beforeAll(async () => {
            ds = await connectTestPostgres({ replica: true });
            if (!ds) return;
            repository = new OrganizationParametersRepository({
                manager: ds.manager,
            } as any);
        });

        afterAll(async () => {
            if (!ds) return;
            await ds.query(
                `DELETE FROM "organization_parameters" WHERE "organization_id" = ANY($1::uuid[])`,
                [organizations],
            );
            await disconnectTestPostgres(ds);
        });

        it("merges one connection's lists, keeping the other connections and the top level", async () => {
            if (!ds) return;
            const organizationId = await organizationWith({
                enabled: true,
                pendingRevocations: { '7': '2026-01-01' },
                connections: {
                    'gh-a': { ignoredUsers: ['1'], seededBotIds: ['b'] },
                    'gl-b': { ignoredUsers: ['2'] },
                },
            });

            await repository.mergeConfigValue(
                KEY,
                organizationId,
                { ignoredUsers: ['9'], allowedUsers: [] },
                { connectionId: 'gh-a' },
            );

            expect(await stored(organizationId)).toEqual([
                {
                    enabled: true,
                    pendingRevocations: { '7': '2026-01-01' },
                    connections: {
                        'gh-a': {
                            ignoredUsers: ['9'],
                            allowedUsers: [],
                            seededBotIds: ['b'],
                        },
                        'gl-b': { ignoredUsers: ['2'] },
                    },
                },
            ]);
        });

        it('adds the first connection entry to a value that had none', async () => {
            if (!ds) return;
            const organizationId = await organizationWith({ enabled: false });

            await repository.mergeConfigValue(
                KEY,
                organizationId,
                { allowedUsers: [] },
                { connectionId: 'gl-b' },
            );

            expect(await stored(organizationId)).toEqual([
                {
                    enabled: false,
                    connections: { 'gl-b': { allowedUsers: [] } },
                },
            ]);
        });

        it('leaves an existing connection entry alone when asked to only add it', async () => {
            if (!ds) return;
            const organizationId = await organizationWith({
                connections: { 'gl-b': { allowedUsers: ['5'] } },
            });

            await repository.mergeConfigValue(
                KEY,
                organizationId,
                { allowedUsers: [] },
                { connectionId: 'gl-b', onlyIfAbsent: true },
            );

            expect(await stored(organizationId)).toEqual([
                { connections: { 'gl-b': { allowedUsers: ['5'] } } },
            ]);
        });

        it('merges top-level keys, and creates the row when the organization has none', async () => {
            if (!ds) return;
            const organizationId = await organizationWith({
                enabled: true,
                connections: { 'gh-a': { ignoredUsers: ['1'] } },
            });
            await repository.mergeConfigValue(KEY, organizationId, {
                pendingRevocations: { '8': 'x' },
            });
            expect(await stored(organizationId)).toEqual([
                {
                    enabled: true,
                    pendingRevocations: { '8': 'x' },
                    connections: { 'gh-a': { ignoredUsers: ['1'] } },
                },
            ]);

            const fresh = await organizationWith();
            await repository.mergeConfigValue(
                KEY,
                fresh,
                { allowedUsers: [] },
                { connectionId: 'gl-b' },
            );
            expect(await stored(fresh)).toEqual([
                { connections: { 'gl-b': { allowedUsers: [] } } },
            ]);
        });

        it("never touches another organization's value", async () => {
            if (!ds) return;
            const neighbour = await organizationWith({
                enabled: true,
                connections: { 'gh-a': { ignoredUsers: ['1'] } },
            });
            const organizationId = await organizationWith({
                connections: { 'gh-a': { ignoredUsers: ['2'] } },
            });

            await repository.mergeConfigValue(
                KEY,
                organizationId,
                { ignoredUsers: ['9'] },
                { connectionId: 'gh-a' },
            );
            await repository.mergeConfigValue(KEY, organizationId, {
                enabled: false,
            });

            expect(await stored(organizationId)).toEqual([
                {
                    enabled: false,
                    connections: { 'gh-a': { ignoredUsers: ['9'] } },
                },
            ]);
            expect(await stored(neighbour)).toEqual([
                {
                    enabled: true,
                    connections: { 'gh-a': { ignoredUsers: ['1'] } },
                },
            ]);
        });

        it('keeps every patch of concurrent first writes in one row', async () => {
            if (!ds) return;
            const fresh = await organizationWith();

            await Promise.all([
                repository.mergeConfigValue(
                    KEY,
                    fresh,
                    { allowedUsers: ['1'] },
                    { connectionId: 'gh-a' },
                ),
                repository.mergeConfigValue(
                    KEY,
                    fresh,
                    { allowedUsers: ['2'] },
                    { connectionId: 'gl-b' },
                ),
                repository.mergeConfigValue(KEY, fresh, {
                    pendingRevocations: { '3': 'x' },
                }),
            ]);

            expect(await stored(fresh)).toEqual([
                {
                    pendingRevocations: { '3': 'x' },
                    connections: {
                        'gh-a': { allowedUsers: ['1'] },
                        'gl-b': { allowedUsers: ['2'] },
                    },
                },
            ]);
        });

        describe('seedBotIds', () => {
            it('adds only bots never seeded before, and leaves the allow list as a concurrent save left it', async () => {
                if (!ds) return;
                const organizationId = await organizationWith({
                    allowedUsers: ['a-saved-meanwhile'],
                    ignoredUsers: ['x'],
                    // b1 was seeded, then an admin chose to review it.
                    seededBotIds: ['b1'],
                });

                await repository.seedBotIds(organizationId, ['b1', 'b2']);

                expect(await stored(organizationId)).toEqual([
                    {
                        allowedUsers: ['a-saved-meanwhile'],
                        ignoredUsers: ['x', 'b2'],
                        seededBotIds: ['b1', 'b2'],
                    },
                ]);
            });

            it("seeds a connection's own lists, creating them, and leaves the organization's alone", async () => {
                if (!ds) return;
                const organizationId = await organizationWith({
                    ignoredUsers: ['x'],
                    connections: {
                        'gh-a': { ignoredUsers: ['1'], seededBotIds: [7] },
                    },
                });

                await repository.seedBotIds(organizationId, ['7', '9'], {
                    connectionId: 'gh-a',
                });
                await repository.seedBotIds(organizationId, ['3'], {
                    connectionId: 'gl-b',
                });

                expect(await stored(organizationId)).toEqual([
                    {
                        ignoredUsers: ['x'],
                        connections: {
                            'gh-a': {
                                ignoredUsers: ['1', '9'],
                                seededBotIds: [7, '9'],
                            },
                            'gl-b': {
                                allowedUsers: [],
                                ignoredUsers: ['3'],
                                seededBotIds: ['3'],
                            },
                        },
                    },
                ]);
            });

            it('creates the row for an organization that has none', async () => {
                if (!ds) return;
                const fresh = await organizationWith();

                await repository.seedBotIds(fresh, ['b1'], {
                    connectionId: 'gh-a',
                });

                expect(await stored(fresh)).toEqual([
                    {
                        connections: {
                            'gh-a': {
                                allowedUsers: [],
                                ignoredUsers: ['b1'],
                                seededBotIds: ['b1'],
                            },
                        },
                    },
                ]);
            });
        });
    },
);
