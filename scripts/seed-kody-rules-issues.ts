import 'dotenv/config';
import { MongoClient, ObjectId, Db } from 'mongodb';
import { randomUUID } from 'crypto';
import { LabelType } from '@/shared/utils/codeManagement/labels';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import { IssueStatus } from '@/config/types/general/issues.type';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';

type PlatformInput = keyof typeof PlatformType;

interface SeedIssueConfig {
    organizationId: string;
    repositoryId: string;
    repositoryName: string;
    repositoryFullName: string;
    platform: PlatformInput;
    count: number;
    prNumberStart: number;
    ownerGitId: string;
    ownerUsername: string;
}

const parseArgs = (): SeedIssueConfig => {
    const args = process.argv.slice(2);
    const getFlagValue = (flag: string): string | undefined => {
        const index = args.indexOf(flag);
        if (index >= 0 && index + 1 < args.length) {
            return args[index + 1];
        }
        return undefined;
    };

    const required = (
        value: string | undefined,
        name: string,
    ): string => {
        if (!value) {
            throw new Error(
                `Missing required flag ${name}. Pass --${name.replace(
                    /([A-Z])/g,
                    '-$1',
                ).toLowerCase()} or set the corresponding environment variable.`,
            );
        }
        return value;
    };

    const organizationId = required(
        getFlagValue('--organization-id') ?? process.env.SEED_ORGANIZATION_ID,
        'organizationId',
    );

    const repositoryId = required(
        getFlagValue('--repository-id') ?? process.env.SEED_REPOSITORY_ID,
        'repositoryId',
    );

    const repositoryName = required(
        getFlagValue('--repository-name') ?? process.env.SEED_REPOSITORY_NAME,
        'repositoryName',
    );

    const repositoryFullName = required(
        getFlagValue('--repository-full-name') ??
            process.env.SEED_REPOSITORY_FULL_NAME,
        'repositoryFullName',
    );

    const platformInput =
        (getFlagValue('--platform') ??
            process.env.SEED_REPOSITORY_PLATFORM ??
            'GITHUB') as PlatformInput;

    if (!(platformInput in PlatformType)) {
        throw new Error(
            `Invalid platform "${platformInput}". Use one of: ${Object.keys(
                PlatformType,
            ).join(', ')}`,
        );
    }

    const count = parseInt(
        getFlagValue('--count') ?? process.env.SEED_ISSUES_COUNT ?? '2',
        10,
    );

    const prNumberStart = parseInt(
        getFlagValue('--pr-number-start') ??
            process.env.SEED_PR_NUMBER_START ??
            '1000',
        10,
    );

    const ownerGitId =
        getFlagValue('--owner-git-id') ??
        process.env.SEED_OWNER_GIT_ID ??
        'seed-owner';
    const ownerUsername =
        getFlagValue('--owner-username') ??
        process.env.SEED_OWNER_USERNAME ??
        'seed.owner';

    return {
        organizationId,
        repositoryId,
        repositoryName,
        repositoryFullName,
        platform: platformInput,
        count: count > 0 ? count : 2,
        prNumberStart,
        ownerGitId,
        ownerUsername,
    };
};

const buildMongoUri = (): {
    uri: string;
    dbName: string;
    summary: string;
} => {
    const user =
        process.env.SEED_MONGO_USER ?? process.env.API_MG_DB_USERNAME ?? '';
    const password =
        process.env.SEED_MONGO_PASSWORD ??
        process.env.API_MG_DB_PASSWORD ??
        '';
    const host =
        process.env.SEED_MONGO_HOST ??
        process.env.API_MG_DB_HOST ??
        'localhost';
    const port = Number(
        process.env.SEED_MONGO_PORT ?? process.env.API_MG_DB_PORT ?? 27017,
    );
    const dbName =
        process.env.SEED_MONGO_DATABASE ??
        process.env.API_MG_DB_DATABASE ??
        'kodus_db';
    const inferredAuthSource =
        process.env.SEED_MONGO_AUTHSOURCE ??
        process.env.API_MG_DB_AUTH_SOURCE;
    const authSource =
        inferredAuthSource ||
        (user ? 'admin' : dbName);

    const encodedUser = encodeURIComponent(user);
    const encodedPass = encodeURIComponent(password);
    const credentials = user ? `${encodedUser}:${encodedPass}@` : '';
    const uri = `mongodb://${credentials}${host}:${port}/${dbName}?authSource=${authSource}`;
    const summary = `mongodb://${user ? `${user}@` : ''}${host}:${port}/${dbName}?authSource=${authSource}`;
    return { uri, dbName, summary };
};

const pickRulesForOrg = async (
    db: Db,
    organizationId: string,
    count: number,
) => {
    const kodyRulesCollection = db.collection('kodyRules');
    const orgRules = await kodyRulesCollection.findOne({
        organizationId,
    });

    if (!orgRules || !Array.isArray(orgRules.rules)) {
        throw new Error(
            `No Kody Rules found for organization ${organizationId}.`,
        );
    }

    const activeRules = orgRules.rules.filter(
        (rule: any) => rule?.status === 'active' && rule?.uuid && rule?.title,
    );

    if (!activeRules.length) {
        throw new Error(
            `Organization ${organizationId} does not have active Kody Rules.`,
        );
    }

    return activeRules.slice(0, count);
};

const buildIssueDoc = (
    cfg: SeedIssueConfig,
    rule: any,
    prNumber: number,
    index: number,
) => {
    const createdAt = new Date(Date.now() - index * 3600 * 1000).toISOString();
    const suggestionId = new ObjectId().toString();

    return {
        title: `[Kody Rule] ${rule.title}`,
        description:
            (rule.rule as string)?.slice(0, 400) ||
            'Automatically seeded issue to test Kody Rules screens.',
        filePath: rule.sourcePath || `src/seeded/rule-${rule.uuid}.ts`,
        language: rule.language || 'typescript',
        label: LabelType.KODY_RULES,
        severity:
            (rule.severity as SeverityLevel) ?? SeverityLevel.MEDIUM,
        status: IssueStatus.OPEN,
        contributingSuggestions: [
            {
                id: suggestionId,
                prNumber,
                prAuthor: {
                    id: cfg.ownerGitId,
                    name: cfg.ownerUsername,
                },
                suggestionContent: `Seeded suggestion referencing rule ${rule.title}`,
                oneSentenceSummary: `${rule.title} is being violated in seeded scenario.`,
                relevantFile: rule.sourcePath || rule.path || 'src/seeded/file.ts',
                language: rule.language || 'typescript',
                brokenKodyRulesIds: [rule.uuid],
            },
        ],
        repository: {
            id: cfg.repositoryId,
            name: cfg.repositoryName,
            full_name: cfg.repositoryFullName,
            platform: PlatformType[cfg.platform],
        },
        organizationId: cfg.organizationId,
        owner: {
            gitId: cfg.ownerGitId,
            username: cfg.ownerUsername,
        },
        reporter: {
            gitId: 'kodus',
            username: 'Kodus',
        },
        createdAt,
        updatedAt: createdAt,
        kodyRule: {
            number: rule.uuid,
            title: rule.title,
        },
        source: 'seed-script',
        externalId: randomUUID(),
    };
};

async function main() {
    const config = parseArgs();
    const { uri, dbName, summary } = buildMongoUri();

    const client = new MongoClient(uri);

    try {
        console.log(`Connecting to MongoDB: ${summary}`);
        await client.connect();
        const db = client.db(dbName);
        const issuesCollection = db.collection('issues');

        const rules = await pickRulesForOrg(
            db,
            config.organizationId,
            config.count,
        );

        const issues = rules.map((rule, idx) =>
            buildIssueDoc(
                config,
                rule,
                config.prNumberStart + idx,
                idx,
            ),
        );

        const result = await issuesCollection.insertMany(issues);

        console.log(
            `✅ Inserted ${result.insertedCount} issues for organization ${config.organizationId}`,
        );
        Object.values(result.insertedIds).forEach((id, index) => {
            console.log(
                `   • Issue #${index + 1}: MongoId=${id.toString()} | Rule=${issues[index].kodyRule?.title}`,
            );
        });
    } catch (error) {
        console.error(
            '❌ Failed to seed Kody Rules issues:',
            (error as Error).message,
        );
        process.exitCode = 1;
    } finally {
        await client.close();
    }
}

main();
