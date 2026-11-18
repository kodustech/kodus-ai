import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime: the repositories of an environment. An environment is the
 * system a pull request runs in; its `primary` repository holds the recipe
 * and stays `runtime_environments.repository_id` (unique per org, unchanged),
 * and every other repository booted beside it is a `member`. A repository may
 * be a member of several environments, and the primary of at most one.
 *
 * Every existing environment gets its primary row: alias = the repository's
 * short name in lower case, every run of characters outside [a-z0-9._-] as
 * one `-`, no leading `.`, `_` or `-`, cut to 63 (repositoryAliasOf in
 * libs/runtime/contracts/workspace.ts), and `repo` when nothing is left.
 * Written by the API only.
 */
export class CreateRuntimeEnvironmentRepositories2026111100000000 implements MigrationInterface {
    name = 'CreateRuntimeEnvironmentRepositories2026111100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "runtime_environment_repositories" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "environment_id" uuid NOT NULL,
                "organization_id" character varying(128) NOT NULL,
                "repository_id" character varying(128) NOT NULL,
                "repository_name" character varying(512) NOT NULL,
                "full_name" character varying(512) NOT NULL,
                "role" character varying(16) NOT NULL,
                "alias" character varying(63) NOT NULL,
                "triggers" boolean NOT NULL DEFAULT true,
                "pair_branches" boolean NOT NULL DEFAULT false,
                "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "updated_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                CONSTRAINT "PK_runtime_environment_repositories" PRIMARY KEY ("uuid"),
                CONSTRAINT "FK_runtime_environment_repositories_environment" FOREIGN KEY ("environment_id") REFERENCES "runtime_environments" ("uuid") ON DELETE CASCADE,
                CONSTRAINT "CHK_runtime_environment_repositories_role" CHECK ("role" IN ('primary', 'member')),
                CONSTRAINT "CHK_runtime_environment_repositories_alias" CHECK ("alias" ~ '^[a-z0-9][a-z0-9._-]{0,62}$')
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runtime_environment_repositories_env_repo" ON "runtime_environment_repositories" ("environment_id", "repository_id")`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runtime_environment_repositories_env_alias" ON "runtime_environment_repositories" ("environment_id", "alias")`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_runtime_environment_repositories_primary" ON "runtime_environment_repositories" ("environment_id") WHERE "role" = 'primary'`,
        );
        // The environments a repository belongs to, by org: what a pull request event looks up.
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_runtime_environment_repositories_org_repo" ON "runtime_environment_repositories" ("organization_id", "repository_id")`,
        );
        await queryRunner.query(`
            INSERT INTO "runtime_environment_repositories"
                ("environment_id", "organization_id", "repository_id", "repository_name", "full_name", "role", "alias", "triggers", "pair_branches")
            SELECT e."uuid", e."organization_id", e."repository_id", e."repository_name", e."repository_name", 'primary',
                COALESCE(
                    NULLIF(left(regexp_replace(regexp_replace(lower(regexp_replace(e."repository_name", '^.*/', '')), '[^a-z0-9._-]+', '-', 'g'), '^[^a-z0-9]+', ''), 63), ''),
                    'repo'
                ),
                true, false
            FROM "runtime_environments" e
            ON CONFLICT DO NOTHING
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "runtime_environment_repositories"`);
    }
}
