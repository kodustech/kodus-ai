import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateRoleColumnTableUser1712951959391
    implements MigrationInterface
{
    name = 'UpdateRoleColumnTableUser1712951959391';

    public async up(queryRunner: QueryRunner): Promise<void> {
        const result = await queryRunner.query(`
            SELECT EXISTS (
                SELECT 1 FROM pg_type WHERE typname = 'users_scopes_enum'
            ) as exists;
        `);

        // Acessar o resultado de forma segura
        const typeExists = result && result[0] && result[0].exists;

        console.log('typeExists', typeExists);
        if (!typeExists) {
            await queryRunner.query(`
                CREATE TYPE users_scopes_enum AS ENUM('root', 'user');
            `);
        }

        await queryRunner.query(
            `ALTER TYPE users_scopes_enum RENAME TO scopes_enum_old;`,
        );

        await queryRunner.query(`
            ALTER TABLE "users"
            ALTER COLUMN "scopes" DROP DEFAULT
        `);

        await queryRunner.query(
            `CREATE TYPE users_scopes_enum AS ENUM ('owner', 'team_leader');`,
        );

        await queryRunner.query(`
            ALTER TABLE users
            ALTER COLUMN scopes TYPE users_scopes_enum USING
            CASE
                WHEN scopes = 'root' THEN 'owner'::users_scopes_enum
                WHEN scopes = 'user' THEN 'team_leader'::users_scopes_enum
            END;
        `);

        await queryRunner.query(`
            ALTER TABLE "users"
                RENAME COLUMN "scopes" TO "role"
        `);

        await queryRunner.query(`
            ALTER TABLE "profiles" DROP COLUMN "role"
        `);

        await queryRunner.query(`
            DROP TYPE "public"."profiles_role_enum"
        `);

        await queryRunner.query(`
            CREATE TYPE "public"."users_role_enum" AS ENUM('team_leader', 'owner')
        `);

        await queryRunner.query(`
            ALTER TABLE "users"
            ALTER COLUMN "role" TYPE "public"."users_role_enum" USING "role":: "text":: "public"."users_role_enum"
        `);

        await queryRunner.query(`
            ALTER TABLE "users"
            ALTER COLUMN "role"
            SET DEFAULT 'owner'
        `);

        await queryRunner.query(`
            DROP TYPE "public"."users_scopes_enum"
        `);

        await queryRunner.query(`DROP TYPE scopes_enum_old;`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Recriar o tipo enum antigo com os valores originais
        const result = await queryRunner.query(`
            SELECT EXISTS (
                SELECT 1 FROM pg_type WHERE typname = 'scopes_enum_old'
            ) as exists;
        `);

        // Acessar o resultado de forma segura
        const typeExists = result && result[0] && result[0].exists;

        console.log('typeExists', typeExists);
        if (!typeExists) {
            await queryRunner.query(`
                CREATE TYPE scopes_enum_old AS ENUM('root', 'user');
            `);
        }

        // await queryRunner.query(`
        //     ALTER TABLE users ALTER COLUMN scopes DROP DEFAULT;
        // `);

        // // Converter a coluna com o novo tipo enum temporário
        // await queryRunner.query(`
        //     ALTER TABLE users
        //     ALTER COLUMN scopes TYPE scopes_enum_old USING (scopes::text::scopes_enum_old);
        // `);

        // // Remover e recriar o tipo enum correto se necessário
        // await queryRunner.query(`DROP TYPE users_role_enum;`);
        // await queryRunner.query(
        //     `ALTER TYPE scopes_enum_old RENAME TO users_scopes_enum;`,
        // );

        // Renomear a coluna de volta para o nome original
        // await queryRunner.query(`
        //     ALTER TABLE "users"
        //     RENAME COLUMN "role" TO "scopes"
        // `);

        // await queryRunner.query(`
        //     DROP TYPE IF EXISTS users_scopes_enum;
        // `);
        // await queryRunner.query(`
        //     ALTER TYPE scopes_enum_old RENAME TO users_scopes_enum;
        // `);

        // // Restaurar a coluna removida na tabela "profiles", se necessário
        // // Você precisa definir qual tipo de dados essa coluna deveria ter.
        // await queryRunner.query(`
        //     ALTER TABLE "profiles" ADD COLUMN "role" TYPE_ALGUM_TIPO_AQUI;
        // `);

        // // Recriar o tipo enum removido se for necessário para a tabela "profiles"
        // await queryRunner.query(`
        //     CREATE TYPE "public"."profiles_role_enum" AS ENUM('seus_valores_aqui');
        // `);

        // // Remover o novo tipo de enum criado para "role"
        // await queryRunner.query(`
        //     DROP TYPE "public"."users_role_enum";
        // `);

        // // Restaurar a definição original do enum para "users"
        // await queryRunner.query(`
        //     ALTER TABLE "users"
        //     ALTER COLUMN "scopes" TYPE users_scopes_enum USING "scopes"::text::users_scopes_enum;
        // `);

        // // Deletar o tipo enum temporário e restaurar o antigo
        // await queryRunner.query(`DROP TYPE users_scopes_enum;`);
        // await queryRunner.query(
        //     `ALTER TYPE scopes_enum_old RENAME TO users_scopes_enum;`,
        // );
    }
}
