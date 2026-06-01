/**
 * Reproduces the quintoandar client setup locally so we can see the
 * "INHERITED: DIRECTORY" leak and the dead-link behavior live.
 *
 * Seeds the local DBs with:
 *   - Two directories on an existing repo (postgres code_review_config)
 *   - Three Kody rules with the same shapes the client reported:
 *       - b207a89c  (Logging Best Practices)  — auto-sync, dirId = cf5284b4
 *       - 32dfa554  (Java/Spring arch)        — auto-sync, dirId = 314f34ff
 *       - ff8ecc7e  (Transaction mgmt)        — hand-created repo-level
 *
 * Run:  npx tsx scripts/reproduce-client-bug.ts
 */

import { Client as PgClient } from 'pg';
import { MongoClient } from 'mongodb';

const PG_URL =
    process.env.PG_URL ||
    'postgres://kodusdev:123456@localhost:5432/kodus_db';
const MONGO_URL =
    process.env.MONGO_URL ||
    'mongodb://kodusdev:123456@localhost:27017/kodus_db?authSource=admin';

// Use the "Kodus" org + its team, which is the one that already has
// a code_review_config row with the kodus-extension repo wired up.
const ORGANIZATION_ID = 'a4330b68-75d8-441e-bb43-7f0a8300980f';
const TEAM_ID = '37dacb3f-99fc-4a80-862e-f8332ddf9c0a';
const REPOSITORY_ID = '1135722979';

// Fixed UUIDs matching the client's data so the UI links look identical
const DIR_QANTILEVER_ID = 'cf5284b4-2510-464a-9eca-98efbf121d04';
const DIR_BACKOFFICE_BFF_ID = '314f34ff-2d1e-47e0-8765-2bb3f1a8564d';

const RULE_LOGGING_UUID = 'b207a89c-924b-4a0a-8070-2e860293b537';
const RULE_JAVA_ARCH_UUID = '32dfa554-6238-4b19-84f8-17330f6abe94';
const RULE_TRANSACTION_UUID = 'ff8ecc7e-24d3-4e65-b2bc-fa250f46887a';

async function updateCodeReviewConfig() {
    const pg = new PgClient({ connectionString: PG_URL });
    await pg.connect();

    const { rows } = await pg.query(
        `SELECT uuid, "configValue"
           FROM parameters
          WHERE "configKey" = 'code_review_config'
            AND team_id = $1
          ORDER BY "updatedAt" DESC
          LIMIT 1`,
        [TEAM_ID],
    );
    if (rows.length === 0) {
        throw new Error(
            `No code_review_config parameter row for team ${TEAM_ID}. Create one via the app first.`,
        );
    }

    const row = rows[0];
    const config = row.configValue;
    const repos = config.repositories || [];
    const repoIdx = repos.findIndex((r: any) => r.id === REPOSITORY_ID);

    const directories = [
        {
            id: DIR_QANTILEVER_ID,
            name: 'qantilever',
            path: 'qantilever',
            isSelected: true,
            configs: {},
        },
        {
            id: DIR_BACKOFFICE_BFF_ID,
            name: 'backoffice-bff',
            path: 'applications/backoffice-bff',
            isSelected: true,
            configs: {},
        },
    ];

    if (repoIdx >= 0) {
        repos[repoIdx].directories = directories;
    } else {
        repos.push({
            id: REPOSITORY_ID,
            name: 'kodus-extension',
            isSelected: true,
            configs: { ideRulesSyncEnabled: false },
            directories,
        });
    }

    config.repositories = repos;

    await pg.query(
        `UPDATE parameters SET "configValue" = $1, "updatedAt" = now() WHERE uuid = $2`,
        [config, row.uuid],
    );

    await pg.end();
    console.log('✓ Postgres: code_review_config updated with 2 directories');
}

async function seedKodyRules() {
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    const db = client.db('kodus_db');
    const collection = db.collection('kodyRules');

    const now = new Date();
    const rules = [
        {
            uuid: RULE_LOGGING_UUID,
            type: 'standard',
            title: 'Logging Best Practices',
            rule: `# Logging Best Practices

Loggers must be declared in a \`companion object\` using:

\`\`\`kotlin
companion object {
    private val log = LoggerFactory.getLogger(ClassName::class.java)
}
\`\`\`

Do NOT use LOGGER, logger, or println.`,
            path: '**/*',
            sourcePath: 'qantilever/.cursor/rules/logging.mdc',
            sourceAnchor: null,
            severity: 'medium',
            status: 'active',
            repositoryId: REPOSITORY_ID,
            directoryId: DIR_QANTILEVER_ID,
            examples: [
                {
                    snippet: `class UserService {
    companion object {
        private val log = LoggerFactory.getLogger(UserService::class.java)
    }
}`,
                    isCorrect: true,
                },
                {
                    snippet: `// Bad: using LOGGER instead of log
private val LOGGER = LoggerFactory.getLogger(...)`,
                    isCorrect: false,
                },
            ],
            origin: 'user',
            scope: 'file',
            inheritance: { inheritable: true, exclude: [], include: [] },
            createdAt: now,
            updatedAt: now,
        },
        {
            uuid: RULE_JAVA_ARCH_UUID,
            type: null,
            title: 'Java/Spring Architectural, Naming, and Dependency Conventions',
            rule: `Enforce hexagonal architecture: ports end with 'Port', adapters with 'Adapter', clients with 'Client'.`,
            path: '**/*',
            sourcePath: 'applications/backoffice-bff/.cursorrules',
            sourceAnchor: null,
            severity: 'high',
            status: 'active',
            repositoryId: REPOSITORY_ID,
            directoryId: DIR_BACKOFFICE_BFF_ID,
            examples: [
                {
                    snippet: `public interface TaskRepository extends JpaRepository<Task, Long> { }`,
                    isCorrect: false,
                },
                {
                    snippet: `public interface TaskRepositoryPort extends JpaRepository<Task, Long> { }`,
                    isCorrect: true,
                },
            ],
            origin: 'user',
            scope: 'file',
            inheritance: { inheritable: true, exclude: [], include: [] },
            createdAt: now,
            updatedAt: now,
        },
        {
            uuid: RULE_TRANSACTION_UUID,
            type: 'standard',
            title: 'Transaction and Data Management Guidelines',
            rule: `Transaction management must be delegated to core services.`,
            path: '**/*',
            sourcePath: null,
            sourceAnchor: null,
            severity: 'medium',
            status: 'active',
            repositoryId: REPOSITORY_ID,
            directoryId: null,
            examples: [],
            origin: 'user',
            scope: 'file',
            inheritance: {
                inheritable: true,
                include: [],
                exclude: [DIR_QANTILEVER_ID],
            },
            createdAt: now,
            updatedAt: now,
        },
    ];

    await collection.updateOne(
        { organizationId: ORGANIZATION_ID },
        {
            $set: {
                organizationId: ORGANIZATION_ID,
                teamId: TEAM_ID,
                updatedAt: now,
            },
            $setOnInsert: { createdAt: now },
            // Replace any existing entries with these three UUIDs, keep the rest
            $pull: {
                rules: {
                    uuid: {
                        $in: [
                            RULE_LOGGING_UUID,
                            RULE_JAVA_ARCH_UUID,
                            RULE_TRANSACTION_UUID,
                        ],
                    },
                },
            },
        } as any,
        { upsert: true },
    );

    await collection.updateOne(
        { organizationId: ORGANIZATION_ID },
        { $push: { rules: { $each: rules } } } as any,
    );

    await client.close();
    console.log('✓ Mongo: kodyRules seeded with 3 rules (b207a89c, 32dfa554, ff8ecc7e)');
}

async function main() {
    await updateCodeReviewConfig();
    await seedKodyRules();
    console.log('\nOpen the app and navigate to:');
    console.log(
        `  http://localhost:3000/settings/code-review/${REPOSITORY_ID}/kody-rules`,
    );
    console.log('and browse each directory to see the INHERITED: DIRECTORY leak.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
