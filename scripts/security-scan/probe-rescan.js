// Contract probe: two independent model scans of one unchanged repository.
// Production start use case, processor, engine, BYOK route, meter, lease manager
// and Mongo repositories. Workflow envelopes and external integration/cache
// gateways supply fixture data; this does not exercise RabbitMQ, PostgreSQL or HTTP.
// node -r dotenv/config scripts/security-scan/probe-rescan.js --output=<file>
require('../../evals/shared/eval-kit').registerTs();
const { countTokens, tokensUsed } = require('../../evals/shared/eval-kit');
const {
    orgRouteOrExit,
    evalPermissionService,
    EVAL_ORG,
} = require('../../evals/shared/model-route');
const { inlineMirror } = require('../../evals/shared/repo-mirror');
const { pricingResolver } = require('../../evals/security-scan/scan-repo');
const { runProvenance } = require('../../evals/security-scan/provenance');
const { ConfigService } = require('@nestjs/config');
const { createConnection } = require('mongoose');
const { randomUUID, createHash } = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
    SecurityScanRepository,
} = require('../../libs/security-scan/infrastructure/security-scan.repository.ts');
const {
    SecurityScanSchema,
} = require('../../libs/security-scan/infrastructure/security-scan.model.ts');
const {
    IssuesSchema,
} = require('../../libs/issues/infrastructure/adapters/repositories/schemas/issues.model.ts');
const {
    IssuesRepository,
} = require('../../libs/issues/infrastructure/adapters/repositories/issues.repository.ts');
const {
    IssuesService,
} = require('../../libs/issues/infrastructure/adapters/service/issues.service.ts');
const {
    SandboxLeaseRepository,
} = require('../../libs/sandbox/infrastructure/repositories/sandbox-lease.repository.ts');
const {
    SandboxLeaseSchema,
} = require('../../libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts');
const {
    SandboxLeaseManager,
} = require('../../libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts');
const {
    LocalSandboxService,
} = require('../../libs/sandbox/infrastructure/providers/local-sandbox.service.ts');
const {
    SpendLimitConfigService,
} = require('../../libs/analytics/application/spend-limit/spend-limit-config.service.ts');
const {
    StartSecurityScanUseCase,
} = require('../../libs/security-scan/application/start-security-scan.use-case.ts');
const {
    SecurityScanJobProcessor,
} = require('../../libs/security-scan/application/security-scan-job.processor.ts');
const {
    PlatformType,
} = require('../../libs/core/domain/enums/platform-type.enum.ts');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => a.replace(/^--/, '').split(/=(.*)/s)),
);
const output = args.output;
const model = args.model || 'deepseek-v4-flash@fireworks';
const budget = Number(args.budget || 1);
const files = {
    'package.json': JSON.stringify({
        name: 'scan-rescan-contract',
        private: true,
        dependencies: { express: '4.21.2', pg: '8.13.3' },
    }),
    'src/products.ts': [
        "import express from 'express';",
        "import { Pool } from 'pg';",
        'const app = express();',
        'const database = new Pool({ connectionString: process.env.DATABASE_URL });',
        '// Public product catalog. Customer and payment tables are private.',
        "app.get('/products/:category', async function products(req, res) {",
        '    const rows = await database.query("SELECT id, name FROM products WHERE category = \'" + req.params.category + "\'");',
        '    res.json(rows.rows);',
        '});',
        'app.listen(Number(process.env.PORT || 3000));',
        '',
    ].join('\n'),
};

async function main() {
    if (!Number.isFinite(budget) || budget <= 0 || budget > 3)
        throw new Error('Use a per-scan budget in (0, 3].');
    if (!process.env.API_CRYPTO_KEY)
        process.env.API_CRYPTO_KEY = '0'.repeat(64);
    countTokens();
    const provenance = runProvenance([]);
    provenance.probeSha256 = createHash('sha256')
        .update(fs.readFileSync(__filename))
        .digest('hex');
    const route = orgRouteOrExit(model);
    const mirror = await inlineMirror(files, {
        branch: 'main',
        baseBranch: 'base',
    });
    const commit = execFileSync(
        'git',
        ['-C', mirror.cloneUrl.replace('file://', ''), 'rev-parse', 'main'],
        { encoding: 'utf8' },
    ).trim();
    const credentials =
        process.env.API_MG_DB_USERNAME && process.env.API_MG_DB_PASSWORD
            ? `${encodeURIComponent(process.env.API_MG_DB_USERNAME)}:${encodeURIComponent(process.env.API_MG_DB_PASSWORD)}@`
            : '';
    const uri =
        process.env.TEST_MONGODB_URI ||
        `mongodb://${credentials}127.0.0.1:27017/kodus_test?authSource=admin`;
    const connection = createConnection(uri, {
        dbName: 'kodus_test',
        serverSelectionTimeoutMS: 10_000,
    });
    const models = [];
    const rounds = [];
    let result;
    try {
        await connection.asPromise();
        const suffix = `${process.pid}_${Date.now()}`;
        const makeModel = (name, schema) => {
            const m = connection.model(
                `${name}_${suffix}`,
                schema.clone(),
                `probe_${name.toLowerCase()}_${suffix}`,
            );
            models.push(m);
            return m;
        };
        const issueModel = makeModel('Issues', IssuesSchema);
        const scanModel = makeModel('Scans', SecurityScanSchema);
        const leaseModel = makeModel('Leases', SandboxLeaseSchema);
        await Promise.all(models.map((m) => m.init()));
        const scans = new SecurityScanRepository(scanModel);
        const issues = new IssuesService(new IssuesRepository(issueModel));
        const config = new ConfigService(process.env);
        const leases = new SandboxLeaseManager(
            new LocalSandboxService(config),
            new SandboxLeaseRepository(leaseModel),
            config,
        );
        const permission = evalPermissionService(route.storedConfig);
        const pricing = pricingResolver();
        const spendConfig = new SpendLimitConfigService(
            { findByKey: async () => null },
            undefined,
            pricing,
        );
        // Boundary fixtures supply the workflow envelope and configured public
        // repository; no production engine or persistence method is replaced.
        const jobs = new Map();
        const pending = [];
        const jobRepository = {
            findOne: async (id) => jobs.get(id),
            update: async (id, changes) => Object.assign(jobs.get(id), changes),
        };
        const queue = {
            enqueue: async (input) => {
                const id = randomUUID();
                jobs.set(id, { id, ...input });
                pending.push(id);
                return jobs.get(id);
            },
        };
        const code = {
            findTypeIntegration: async () => PlatformType.GITHUB,
            getDefaultBranch: async () => 'main',
            getCloneParams: async () => ({
                url: mirror.cloneUrl,
                auth: { token: '' },
            }),
        };
        const repositories = {
            findIntegrationConfigFormatted: async () => [
                {
                    id: 'scan-rescan-contract',
                    name: 'scan-rescan-contract',
                    full_name: 'eval/scan-rescan-contract',
                    http_url: 'https://github.com/eval/scan-rescan-contract',
                    default_branch: 'main',
                },
            ],
        };
        const start = new StartSecurityScanUseCase(
            scans,
            queue,
            repositories,
            permission,
            code,
            pricing,
            spendConfig,
        );
        const processor = new SecurityScanJobProcessor(
            jobRepository,
            queue,
            scans,
            leases,
            code,
            permission,
            pricing,
            spendConfig,
            issues,
            { clearIssuesCache: async () => undefined },
        );
        for (let round = 1; round <= 2; round++) {
            const before = await issueModel.find().lean();
            const scan = await start.execute({
                organizationAndTeamData: EVAL_ORG,
                repositoryId: 'scan-rescan-contract',
                budget: { maxUsd: budget },
            });
            let slices = 0;
            while (pending.length) {
                if (++slices > 4)
                    throw new Error('Probe exceeded four slices.');
                await processor.process(
                    pending.shift(),
                    AbortSignal.timeout(25 * 60_000),
                );
            }
            const saved = await scans.findById(scan.uuid);
            const after = await issueModel.find().lean();
            const row = {
                round,
                commitSha: saved.commitSha,
                status: saved.status,
                outcome: saved.outcome,
                spend: saved.spend,
                budgetUsd: budget,
                coverage: saved.coverage,
                error: saved.error,
                issueCount: after.length,
                addedIdentities: after.filter(
                    (a) => !before.some((b) => String(a._id) === String(b._id)),
                ).length,
                removedIdentities: before.filter(
                    (b) => !after.some((a) => String(a._id) === String(b._id)),
                ).length,
                issues: after.map((i) => ({
                    id: String(i._id),
                    fingerprint: i.fingerprint,
                    status: i.status,
                    lastSeenScanId: i.lastSeenScanId,
                    consecutiveScanMisses: i.consecutiveScanMisses,
                    file: i.filePath,
                    symbol: i.symbol,
                    cwe: i.cwe,
                })),
            };
            rounds.push(row);
            console.log('RESCAN_ROUND', JSON.stringify(row));
        }
        const [first, second] = rounds;
        const checks = {
            bothCompleted: rounds.every(
                (r) =>
                    r.status === 'completed' &&
                    r.coverage?.unitsDone === r.coverage?.unitsTotal,
            ),
            sameCommit: rounds.every((r) => r.commitSha === commit),
            sameIssueIds:
                first.issues.length === second.issues.length &&
                first.issues.every((a) => second.issues.some((b) => a.id === b.id)),
            nonVacuous: first.issueCount > 0 && first.outcome?.created > 0,
            noNewIssues:
                second.addedIdentities === 0 && second.outcome?.created === 0,
            noResolvedIssues:
                second.removedIdentities === 0 &&
                second.outcome?.resolved === 0 &&
                second.issues.every((i) => i.status === 'open'),
            foundAgain: second.outcome?.stillOpen > 0,
            capsHeld: rounds.every((r) => r.spend.usd <= budget),
        };
        result = {
            kind: 'contract-with-real-model',
            provenance,
            model,
            repository: { commit, files },
            boundaries:
                'Production start/processor/engine/BYOK/meter/local sandbox/lease manager/scan and issue Mongo repositories; fixture workflow envelopes, integration and cache gateways. No HTTP, RabbitMQ or PostgreSQL.',
            checks,
            passed: Object.values(checks).every(Boolean),
            rounds,
            tokens: tokensUsed(),
        };
        process.exitCode = result.passed ? 0 : 1;
    } finally {
        if (result && output) {
            fs.mkdirSync(path.dirname(output), { recursive: true });
            fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
        }
        for (const m of models)
            await m.collection.drop().catch(() => undefined);
        await connection.close().catch(() => undefined);
        await mirror.cleanup();
    }
}
main().catch((error) => {
    console.error('Rescan probe failed:', error.name);
    process.exitCode = 2;
});
