import { DataSource } from 'typeorm';

import { connectTestPostgres } from './postgres-integration';

/**
 * Locally an unreachable Postgres skips the integration specs; in CI, where
 * the job starts Postgres, it fails them, so a green run never hides specs
 * that did not run.
 */
describe('connectTestPostgres', () => {
    const ci = process.env.CI;
    const refused = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
    });

    beforeEach(() => {
        jest.spyOn(DataSource.prototype, 'initialize').mockRejectedValue(
            refused,
        );
        jest.spyOn(DataSource.prototype, 'destroy').mockResolvedValue(
            undefined,
        );
    });

    afterEach(() => {
        jest.restoreAllMocks();
        if (ci === undefined) delete process.env.CI;
        else process.env.CI = ci;
    });

    it.each([undefined, 'false', '0'])(
        'answers no connection, so the spec skips, when Postgres is not reachable locally (CI=%s)',
        async (value) => {
            if (value === undefined) delete process.env.CI;
            else process.env.CI = value;

            await expect(connectTestPostgres()).resolves.toBeUndefined();
        },
    );

    it.each(['true', '1'])(
        'fails when Postgres is not reachable in CI (CI=%s)',
        async (value) => {
            process.env.CI = value;

            await expect(connectTestPostgres()).rejects.toBe(refused);
        },
    );
});
