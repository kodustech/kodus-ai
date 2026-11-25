import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GlobalParametersKey } from './global-parameters-key.enum';

/**
 * `global_parameters.configKey` is a Postgres enum, and TypeORM does not
 * generate `ALTER TYPE ... ADD VALUE`. A key added to the TypeScript enum
 * alone is refused by the database on every read and write that names it.
 */
describe('GlobalParametersKey', () => {
    const MIGRATIONS = join(
        __dirname,
        '../../infrastructure/database/typeorm/migrations',
    );
    const enumMigrations = readdirSync(MIGRATIONS)
        .filter((file) => file.endsWith('.ts'))
        .map((file) => readFileSync(join(MIGRATIONS, file), 'utf8'))
        .filter((source) =>
            source.includes('global_parameters_configkey_enum'),
        );

    it.each(Object.values(GlobalParametersKey))(
        'has a migration that adds %s to the database enum',
        (key) => {
            expect(
                enumMigrations.some((source) => source.includes(`'${key}'`)),
            ).toBe(true);
        },
    );
});
