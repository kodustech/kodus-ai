/**
 * INTEGRATION TEST — UserRepository.getLoginData against a real Postgres.
 *
 * Proves the case-insensitive, exact-match-first email resolver on the real
 * TypeORM query path (not just the raw SQL): a mixed-case account is found when
 * queried with a different case (so OAuth/password login no longer miss it and
 * OAuth stops creating a second, empty account), while an exact-case match
 * still wins over a case-variant so distinct accounts never merge.
 *
 * Runs inside a transaction that is rolled back, so it never pollutes the DB.
 * It does not silently pass when Postgres is down: set SKIP_INTEGRATION=true to
 * skip it explicitly, otherwise an unreachable DB fails the suite instead of
 * reporting the tests as passed without reaching their assertions.
 */
require('dotenv').config();

import { randomUUID } from 'node:crypto';

import { DataSource, QueryRunner } from 'typeorm';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { ENTITIES } from '@libs/core/infrastructure/database/typeorm/entities';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { OrganizationModel } from '@libs/organization/infrastructure/adapters/repositories/schemas/organization.model';

import { UserModel } from './schemas/user.model';
import { UserDatabaseRepository } from './user.repository';

const dataSource = new DataSource({
    type: 'postgres',
    // Default to localhost (the mapped port): API_PG_DB_HOST from .env is the
    // in-docker service name and does not resolve from a host/CI runner — using
    // it is exactly what let this suite "pass" without ever connecting. CI
    // overrides with TEST_PG_HOST when the DB is elsewhere.
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
    logging: false,
    synchronize: false,
    entities: ENTITIES,
});

const UNREACHABLE = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
]);
const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

(skipIntegration ? describe.skip : describe)(
    'UserRepository.getLoginData (integration, real Postgres)',
    () => {
        let queryRunner: QueryRunner;
        let repo: UserDatabaseRepository;
        const sfx = randomUUID().slice(0, 8);
        const domain = `citest-${sfx}.invalid`;

        beforeAll(async () => {
            try {
                await dataSource.initialize();
            } catch (e: any) {
                if (UNREACHABLE.has(e?.code)) {
                    // Fail loudly rather than let the tests report "passed"
                    // without reaching their assertions. An environment with no
                    // Postgres opts out explicitly with SKIP_INTEGRATION=true.
                    throw new Error(
                        `Postgres is required for this integration suite but was unreachable (${e.code}). ` +
                            `Start the DB, or set SKIP_INTEGRATION=true to skip it explicitly.`,
                    );
                }
                throw e;
            }
        });

        afterAll(async () => {
            if (dataSource.isInitialized) await dataSource.destroy();
        });

        beforeEach(async () => {
            queryRunner = dataSource.createQueryRunner();
            await queryRunner.connect();
            await queryRunner.startTransaction();
            repo = new UserDatabaseRepository(
                queryRunner.manager.getRepository(UserModel) as any,
                dataSource,
            );
        });

        afterEach(async () => {
            await queryRunner.rollbackTransaction();
            await queryRunner.release();
        });

        const seedUser = async (email: string): Promise<string> => {
            const org = await queryRunner.manager
                .getRepository(OrganizationModel)
                .save({ name: `org-${sfx}-${email}` });
            await queryRunner.manager.getRepository(UserModel).save({
                email,
                password: 'x',
                role: Role.OWNER,
                status: STATUS.ACTIVE,
                organization: { uuid: org.uuid },
            });
            return org.uuid;
        };

        it('finds a mixed-case account queried with a different case', async () => {
            await seedUser(`Mixed@${domain}`);

            const found = await repo.getLoginData(`mixed@${domain}`);

            expect(found?.email).toBe(`Mixed@${domain}`);
        });

        it('prefers an exact-case match over a case-variant (no merge)', async () => {
            const upperOrg = await seedUser(`User@${domain}`);
            const lowerOrg = await seedUser(`user@${domain}`);

            const foundUpper = await repo.getLoginData(`User@${domain}`);
            const foundLower = await repo.getLoginData(`user@${domain}`);

            expect(foundUpper?.organization?.uuid).toBe(upperOrg);
            expect(foundLower?.organization?.uuid).toBe(lowerOrg);
        });

        it('returns undefined when no account matches, even case-insensitively', async () => {
            const found = await repo.getLoginData(`ghost@${domain}`);
            expect(found).toBeUndefined();
        });
    },
);
