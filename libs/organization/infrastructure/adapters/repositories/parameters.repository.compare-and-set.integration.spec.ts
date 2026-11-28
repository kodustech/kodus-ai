/**
 * INTEGRATION TEST: ParametersRepository.compareAndSetConfigValue against a
 * real Postgres. Skips when Postgres is not reachable.
 */
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

import {
    connectTestPostgres,
    disconnectTestPostgres,
    skipPostgresIntegration,
} from '../../../../../test/helpers/postgres-integration';
import { ParametersRepository } from './parameters.repository';

(skipPostgresIntegration ? describe.skip : describe)(
    'ParametersRepository.compareAndSetConfigValue (integration, real Postgres)',
    () => {
        let ds: DataSource | undefined;
        let repository: ParametersRepository;
        const uuid = randomUUID();
        const neighbour = randomUUID();
        const stored = {
            enabled: true,
            repository: { id: 'r-1' },
            connections: { 'gl-b': { enabled: true } },
        };

        const read = async (row = uuid) =>
            (
                (await ds!.query(
                    `SELECT "configValue" FROM "parameters" WHERE "uuid" = $1`,
                    [row],
                )) as Array<{ configValue: unknown }>
            )[0]?.configValue;

        beforeAll(async () => {
            ds = await connectTestPostgres({ replica: true });
            if (!ds) return;
            repository = new ParametersRepository({
                manager: ds.manager,
            } as any);
            // Another workspace holding the very same value.
            await ds.query(
                `INSERT INTO "parameters" ("uuid", "configKey", "configValue", "team_id", "active", "version")
                 VALUES ($1, 'centralized_config', $3::jsonb, $4, true, 1),
                        ($2, 'centralized_config', $3::jsonb, $5, true, 1)`,
                [
                    uuid,
                    neighbour,
                    JSON.stringify(stored),
                    randomUUID(),
                    randomUUID(),
                ],
            );
        });

        afterAll(async () => {
            if (!ds) return;
            await ds.query(
                `DELETE FROM "parameters" WHERE "uuid" = ANY($1::uuid[])`,
                [[uuid, neighbour]],
            );
            await disconnectTestPostgres(ds);
        });

        it('writes over the value it read, whatever the key order', async () => {
            if (!ds) return;
            const sameInAnotherOrder = {
                connections: { 'gl-b': { enabled: true } },
                repository: { id: 'r-1' },
                enabled: true,
            };
            const next = { ...stored, enabled: false };

            await expect(
                repository.compareAndSetConfigValue(
                    uuid,
                    sameInAnotherOrder,
                    next,
                ),
            ).resolves.toBe(true);
            expect(await read()).toEqual(next);
            expect(await read(neighbour)).toEqual(stored);
        });

        it('writes nothing over a value another save changed', async () => {
            if (!ds) return;

            await expect(
                repository.compareAndSetConfigValue(uuid, stored, {
                    overwritten: true,
                }),
            ).resolves.toBe(false);
            expect(await read()).toEqual({ ...stored, enabled: false });
        });
    },
);
