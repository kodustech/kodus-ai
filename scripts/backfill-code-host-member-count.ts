#!/usr/bin/env -S npx ts-node -r tsconfig-paths/register
/**
 * Backfill `codeHostMemberCount` on existing organizations.
 *
 * Why this exists:
 *   `FinishOnboardingUseCase` persists the git org's member count, but it only
 *   started doing so in July 2026 and only fires at onboarding. Every org that
 *   onboarded before that has the column NULL forever — 11 of 3971 orgs had a
 *   value when this script was written. Downstream (growth/CRM lead scoring)
 *   that means team size falls back to counting distinct PR authors, which
 *   undercounts internal teams and overcounts open-source projects, where
 *   external contributors dominate.
 *
 * What it does:
 *   For each org with an active code-management integration and no member count
 *   (or a stale one, with --refresh-older-than-days), calls
 *   `CodeManagementService.getListMembers` — the same call the onboarding path
 *   makes — and writes codeHostMemberCount + codeHostMemberCountUpdatedAt.
 *
 *   Read-only against the git provider. The only write is those two columns.
 *
 * Designed to be run from a laptop over VPN, so it assumes the connection can
 * drop at any moment:
 *   - progress is checkpointed to disk after every org, and a re-run skips
 *     whatever already succeeded (and, unless --retry-failed, whatever already
 *     failed for a non-transient reason);
 *   - every provider call is time-bounded, because a rate-limited octokit
 *     parks the request until the quota resets rather than failing (this is
 *     the bug that once held finish-onboarding hostage for ~6 minutes a try);
 *   - concurrency defaults to 1. Raise it only if the provider quota allows.
 *
 * Usage:
 *   # See what would run, touching nothing
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-code-host-member-count.ts --all --dry-run
 *
 *   # Prove the path on a small slice first
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-code-host-member-count.ts --all --limit=20
 *
 *   # The real run (resume-safe: just re-run it if the VPN drops)
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-code-host-member-count.ts --all --env=.env.prod
 *
 *   # One org
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-code-host-member-count.ts --org-id=<uuid>
 *
 *   # Only one provider — GitHub needs the App key, the others authenticate
 *   # with a per-integration token already in the database
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-code-host-member-count.ts --all --platform=GITLAB
 *
 *   # Re-measure orgs whose count is older than 90 days
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-code-host-member-count.ts --all --refresh-older-than-days=90
 *
 *   # Retry the transient failures (rate limit, dropped VPN)
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-code-host-member-count.ts --all --retry-failed
 *
 *   # Also reconsider installations previously judged dead
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-code-host-member-count.ts --all --retry-failed --retry-permanent
 *
 * The `-r tsconfig-paths/register` is required: the script imports through the
 * @libs/* aliases, which plain ts-node does not resolve.
 *
 * Required env: PG connection (API_PG_DB_*) plus whatever the provider
 * integrations need — the same set as running the API itself.
 */

import 'dotenv/config';
import 'reflect-metadata';

import * as fs from 'fs';
import * as path from 'path';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';

import { LLMModule } from '@kodus/kodus-common/llm';

import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { FeatureGateModule } from '@libs/feature-gate/modules/feature-gate.module';
import { IncidentModule } from '@libs/core/infrastructure/incident/incident.module';
import { LoggerWrapperService } from '@libs/core/log/loggerWrapper.service';
import { MetricsModule } from '@libs/core/infrastructure/metrics/metrics.module';
import { RabbitMQWrapperModule } from '@libs/core/infrastructure/queue/rabbitmq.module';
import { SharedLogModule } from '@libs/shared/infrastructure/shared-log.module';
import { SharedObservabilityModule } from '@libs/shared/infrastructure/shared-observability.module';
import { TelemetryModule } from '@libs/telemetry/modules/telemetry.module';
import { SharedConfigModule } from '@libs/shared/infrastructure/shared-config.module';
import { SharedMongoModule } from '@libs/shared/database/shared-mongo.module';
import { SharedPostgresModule } from '@libs/shared/database/shared-postgres.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

/** Matches the bound used in finish-onboarding: generous for a healthy member
 *  list, short enough that a throttled provider does not stall the run. */
const MEMBER_LIST_TIMEOUT_MS = 10_000;

const CHECKPOINT_FILE = path.resolve(
    process.cwd(),
    '.backfill-code-host-member-count.json',
);

interface CliArgs {
    orgId?: string;
    all: boolean;
    dryRun: boolean;
    limit?: number;
    concurrency: number;
    refreshOlderThanDays?: number;
    retryFailed: boolean;
    retryPermanent: boolean;
    platform?: string;
    forceSsl: boolean;
    noSsl: boolean;
    envFile?: string;
}

/** integrations.platform values that carry a code-management integration. */
const KNOWN_PLATFORMS = new Set([
    'GITHUB',
    'GITLAB',
    'BITBUCKET',
    'AZURE_REPOS',
]);

interface Target {
    organizationId: string;
    organizationName: string;
    teamId: string;
    platform: string;
    currentCount: number | null;
}

type CheckpointEntry = {
    status: 'ok' | 'failed';
    count?: number;
    error?: string;
    /** Retrying cannot help: the installation is gone, suspended or revoked.
     *  Skipped even under --retry-failed, unless --retry-permanent is given. */
    permanent?: boolean;
    at: string;
};

/**
 * Provider answers that mean "this will never work until a human reinstalls the
 * app", as opposed to a rate limit or a dropped VPN. Retrying these on every
 * run is pure waste and buries the failures that are actually actionable.
 */
const PERMANENT_FAILURE = [
    /installation has been suspended/i,
    /^not found/i, // create-an-installation-access-token: installation deleted
    /bad credentials/i,
    /resource not accessible by integration/i,
    /revoked/i,
];

function isPermanentFailure(message: string): boolean {
    return PERMANENT_FAILURE.some((re) => re.test(message));
}

type Checkpoint = Record<string, CheckpointEntry>;

function parseArgs(): CliArgs {
    const argv = process.argv.slice(2);
    const get = (flag: string): string | undefined => {
        const eq = argv.find((a) => a.startsWith(`${flag}=`));
        if (eq) return eq.slice(flag.length + 1);
        const i = argv.indexOf(flag);
        if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
        return undefined;
    };

    const out: CliArgs = {
        orgId: get('--org-id'),
        all: argv.includes('--all'),
        dryRun: argv.includes('--dry-run'),
        limit: get('--limit') ? Number(get('--limit')) : undefined,
        concurrency: get('--concurrency') ? Number(get('--concurrency')) : 1,
        refreshOlderThanDays: get('--refresh-older-than-days')
            ? Number(get('--refresh-older-than-days'))
            : undefined,
        retryFailed: argv.includes('--retry-failed'),
        retryPermanent: argv.includes('--retry-permanent'),
        platform: get('--platform')?.toUpperCase(),
        forceSsl: argv.includes('--ssl'),
        noSsl: argv.includes('--no-ssl'),
        envFile: get('--env'),
    };

    if (!out.orgId && !out.all) {
        throw new Error('Provide one of: --org-id=<uuid>, or --all');
    }
    if (out.all && out.orgId) {
        throw new Error('--all cannot be combined with --org-id');
    }
    if (!Number.isFinite(out.concurrency) || out.concurrency < 1) {
        throw new Error('--concurrency must be a positive integer');
    }
    if (out.limit != null && (!Number.isFinite(out.limit) || out.limit < 1)) {
        throw new Error('--limit must be a positive integer');
    }
    if (out.forceSsl && out.noSsl) {
        throw new Error('--ssl and --no-ssl are mutually exclusive');
    }
    if (out.platform && !KNOWN_PLATFORMS.has(out.platform)) {
        throw new Error(
            `--platform must be one of: ${[...KNOWN_PLATFORMS].join(', ')}`,
        );
    }
    return out;
}

function loadEnvFile(envFile?: string): void {
    if (!envFile) return;
    // dotenv/config already loaded `.env` at import time. Apply a second pass
    // on the explicit file so its values override.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('dotenv').config({ path: path.resolve(envFile), override: true });
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

function readCheckpoint(): Checkpoint {
    try {
        return JSON.parse(
            fs.readFileSync(CHECKPOINT_FILE, 'utf8'),
        ) as Checkpoint;
    } catch {
        return {};
    }
}

function writeCheckpoint(cp: Checkpoint): void {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

/** Hosts that mean "the Postgres on this machine / in the dev compose stack". */
const LOCAL_PG_HOSTS = new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    'db_postgres',
    'host.docker.internal',
]);

/**
 * TLS is decided by the host, NOT by API_DATABASE_DISABLE_SSL.
 *
 * That variable lives in the repo's local `.env`, which `dotenv/config` loads
 * at import time regardless of what `--env` (or `op run --env-file`) points at.
 * Honouring it here means a laptop's dev setting silently disables encryption
 * against the production database — Postgres then rejects the connection with
 * "no pg_hba.conf entry ... no encryption", which reads like a firewall or
 * credentials problem and sends you looking in the wrong place.
 *
 * Production servers never have that `.env` present, which is why the app
 * itself can read the flag safely and this script cannot.
 */
function shouldUseSsl(host: string, args: CliArgs): boolean {
    if (args.noSsl) return false;
    if (args.forceSsl) return true;
    return !LOCAL_PG_HOSTS.has(host);
}

function pgClient(args: CliArgs): Client {
    const host = requireEnv('API_PG_DB_HOST');
    return new Client({
        host,
        port: Number(process.env.API_PG_DB_PORT ?? 5432),
        user: requireEnv('API_PG_DB_USERNAME'),
        password: requireEnv('API_PG_DB_PASSWORD'),
        database: requireEnv('API_PG_DB_DATABASE'),
        // rejectUnauthorized:false matches TypeORMFactory — the managed
        // instance presents a cert this client has no CA bundle for.
        ssl: shouldUseSsl(host, args) ? { rejectUnauthorized: false } : false,
    });
}

/**
 * Orgs worth calling the provider for: an active code-management integration
 * (no integration, no members to list) and a team to scope the call to.
 *
 * One row per org — an org with several teams only needs one member list, and
 * the provider org is the same for all of them.
 *
 * Personal git accounts are excluded here rather than discovered by failing.
 * A personal account has no org to enumerate, so getListMembers falls back to
 * GET /user, which an App installation token may not call — the request comes
 * back "Resource not accessible by integration", which reads like a permissions
 * bug and is really the absence of the concept. auth_integrations already
 * records this as authDetails->>'accountType', and in a 20-org GitHub sample
 * 9 of the 16 failures were exactly this. They are also excluded from the CRM
 * downstream, so the call has no consumer either way.
 */
async function loadTargets(args: CliArgs): Promise<Target[]> {
    const pg = pgClient(args);
    await pg.connect();
    try {
        const where: string[] = [
            `i.status = true`,
            `i."integrationCategory" = 'CODE_MANAGEMENT'`,
            `o.status = true`,
            // Latest auth row per org decides; older rows can predate a
            // reinstall onto a real organisation.
            `COALESCE(LOWER((
                 SELECT a."authDetails"->>'accountType'
                   FROM auth_integrations a
                  WHERE a.organization_id = o.uuid
                  ORDER BY a."createdAt" DESC
                  LIMIT 1
             )), '') <> 'user'`,
        ];
        const params: unknown[] = [];

        if (args.orgId) {
            params.push(args.orgId);
            where.push(`o.uuid = $${params.length}`);
        }
        if (args.platform) {
            params.push(args.platform);
            where.push(`i.platform = $${params.length}`);
        }
        if (args.refreshOlderThanDays != null) {
            params.push(args.refreshOlderThanDays);
            where.push(
                `(o.code_host_member_count IS NULL
                  OR o.code_host_member_count_updated_at IS NULL
                  OR o.code_host_member_count_updated_at < now() - ($${params.length}::int * interval '1 day'))`,
            );
        } else {
            where.push(`o.code_host_member_count IS NULL`);
        }

        const { rows } = await pg.query(
            `SELECT DISTINCT ON (o.uuid)
                    o.uuid  AS "organizationId",
                    o.name  AS "organizationName",
                    t.uuid  AS "teamId",
                    i.platform AS "platform",
                    o.code_host_member_count AS "currentCount"
             FROM organizations o
             JOIN integrations i ON i.organization_id = o.uuid
             JOIN teams t ON t.uuid = i.team_id
             WHERE ${where.join(' AND ')}
             ORDER BY o.uuid, t."createdAt" ASC`,
            params,
        );
        return rows as Target[];
    } finally {
        await pg.end();
    }
}

async function persistCount(
    args: CliArgs,
    organizationId: string,
    count: number,
): Promise<void> {
    const pg = pgClient(args);
    await pg.connect();
    try {
        await pg.query(
            `UPDATE organizations
                SET code_host_member_count = $2,
                    code_host_member_count_updated_at = now()
              WHERE uuid = $1`,
            [organizationId, count],
        );
    } finally {
        await pg.end();
    }
}

/**
 * The try/catch around a provider call only covers rejections, not hangs: a
 * throttled octokit parks the request until the quota resets. Race it.
 */
async function listMembersBounded(
    codeManagement: CodeManagementService,
    organizationAndTeamData: OrganizationAndTeamData,
): Promise<unknown[] | null> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
        const members = await Promise.race([
            codeManagement.getListMembers({ organizationAndTeamData }),
            new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(
                    () =>
                        reject(
                            new Error(
                                `getListMembers timed out after ${MEMBER_LIST_TIMEOUT_MS / 1000}s (likely provider rate-limit throttling)`,
                            ),
                        ),
                    MEMBER_LIST_TIMEOUT_MS,
                );
                timeoutHandle.unref?.();
            }),
        ]);
        return Array.isArray(members) ? members : null;
    } finally {
        clearTimeout(timeoutHandle);
    }
}

/**
 * Standalone module.
 *
 * PlatformModule cannot be booted on its own: resolving CodeManagementService
 * drags in most of the platform, and each missing root surfaces one at a time
 * as an UnknownDependenciesException — DataSource, then Mongoose, then
 * ConfigService, then MessageBrokerService, then PromptRunnerService. The list
 * below is the one apps/report-cli/src/main.ts already converged on for the
 * same graph; adopting it wholesale beats discovering it error by error.
 *
 * The broker is registered DISABLED, and that is not cosmetic. NotificationModule
 * registers ScheduleModule.forRoot(), and WorkflowModule's OutboxRelayService
 * starts adaptive polling in onApplicationBootstrap — which
 * createApplicationContext does fire. A live broker here would turn a laptop
 * into a production worker: publishing real outbox messages and competing for
 * cron locks with the actual workers. With it down, processOutbox()
 * short-circuits on `!messageBroker.isConnected()` and claims nothing.
 */
@Module({
    imports: [
        SharedConfigModule,
        SharedLogModule,
        SharedObservabilityModule,
        TelemetryModule,
        FeatureGateModule,
        IncidentModule,
        MetricsModule,
        SharedPostgresModule.forRoot({ poolSize: 4 }),
        SharedMongoModule.forRoot(),
        // Pulled in by DocumentationContextModule's planner at bootstrap; this
        // script never calls a model.
        LLMModule.forRoot({ logger: LoggerWrapperService }),
        RabbitMQWrapperModule.register({ enableConsumers: false }),
        PlatformModule,
    ],
})
class BackfillCodeHostMemberCountModule {}

/**
 * Make the app's own factories agree with what this script decided: no broker,
 * and a TypeORM connection that matches the target host.
 *
 * TypeORMFactory computes `useSSL = isProduction && !disableSSL` from
 * API_DATABASE_ENV / API_NODE_ENV / API_DATABASE_DISABLE_SSL — all three of
 * which the repo's local `.env` pins to development values, and none of which
 * `.env.prod` overrides. Left alone, the DataSource would connect to production
 * without TLS and die on pg_hba, exactly like the raw pg client did before the
 * host-based check went in.
 *
 * Only touches the process env when this run targets a remote host.
 */
function alignRuntimeEnvWithTarget(
    host: string,
    args: CliArgs,
    logger: Logger,
): void {
    // Unconditional: this script never needs the broker, on any target. Set
    // before bootstrap because RabbitMQWrapperModule reads it at registration.
    process.env.API_RABBITMQ_ENABLED = 'false';

    if (!shouldUseSsl(host, args)) return;
    process.env.API_DATABASE_DISABLE_SSL = 'false';
    if (['development', 'test'].includes(process.env.API_DATABASE_ENV ?? '')) {
        process.env.API_DATABASE_ENV = 'production';
    }
    if (
        process.env.API_DATABASE_ENV == null &&
        ['development', 'test'].includes(process.env.API_NODE_ENV ?? '')
    ) {
        process.env.API_DATABASE_ENV = 'production';
    }

    // Same leak, worse failure mode. mongoDBConfigLoader prefers a whole
    // connection URL over the discrete API_MG_DB_* vars:
    //
    //     const connectionUrl = process.env.MONGODB_URI ?? process.env.API_MG_DB_URI;
    //
    // The local `.env` sets MONGODB_URI; `.env.prod` does not. Unlike the SSL
    // case this does not fail — it silently wires Mongo to the laptop's docker
    // container while Postgres points at production. Neutralise the override
    // when it is unmistakably local, so the discrete prod vars win.
    //
    // Blanked, not deleted: SharedConfigModule re-reads `.env` through
    // ConfigModule.forRoot({ envFilePath }), and @nestjs/config only fills keys
    // that are absent from process.env. A deleted key comes straight back; an
    // empty one stays empty and fails the loader's `if (connectionUrl)` check,
    // which is exactly the fall-through we want. Neither var is in the Joi
    // schema, so an empty value cannot trip validation.
    for (const key of ['MONGODB_URI', 'API_MG_DB_URI']) {
        const value = process.env[key];
        if (!value) continue;
        if (
            /(localhost|127\.0\.0\.1|@mongodb[:/]|\/\/mongodb[:/])/i.test(value)
        ) {
            process.env[key] = '';
            logger.warn(
                `ignoring local ${key} from .env — targeting a remote database, using API_MG_DB_* instead`,
            );
        }
    }
}

async function main() {
    const logger = new Logger('backfill-code-host-member-count');
    const args = parseArgs();
    loadEnvFile(args.envFile);

    const checkpoint = readCheckpoint();
    const done = new Set(
        Object.entries(checkpoint)
            .filter(([, v]) => {
                if (v.status === 'ok') return true;
                if (!args.retryFailed) return true;
                // --retry-failed retries the transient ones; the dead
                // installations need --retry-permanent to be reconsidered.
                return v.permanent === true && !args.retryPermanent;
            })
            .map(([k]) => k),
    );

    let targets = await loadTargets(args);
    const skipped = targets.filter((t) => done.has(t.organizationId)).length;
    targets = targets.filter((t) => !done.has(t.organizationId));
    if (args.limit != null) targets = targets.slice(0, args.limit);

    logger.log(
        `${targets.length} org(s) to process` +
            (skipped > 0
                ? ` (${skipped} already in checkpoint, skipped)`
                : '') +
            (args.limit != null ? ` [--limit=${args.limit}]` : ''),
    );
    if (targets.length === 0) return;

    if (args.dryRun) {
        for (const t of targets) {
            logger.log(
                `  ${t.organizationId} | ${t.platform} | current=${t.currentCount ?? 'null'} | ${t.organizationName}`,
            );
        }
        logger.log('[DRY RUN] no provider calls, no writes — exiting');
        return;
    }

    alignRuntimeEnvWithTarget(requireEnv('API_PG_DB_HOST'), args, logger);

    const app = await NestFactory.createApplicationContext(
        BackfillCodeHostMemberCountModule,
        { logger: ['warn', 'error'] },
    );

    let ok = 0;
    let failed = 0;
    let empty = 0;
    let permanentCount = 0;
    try {
        const codeManagement = app.get(CodeManagementService);

        const queue = [...targets];
        const worker = async () => {
            for (;;) {
                const t = queue.shift();
                if (!t) return;
                try {
                    const members = await listMembersBounded(codeManagement, {
                        organizationId: t.organizationId,
                        teamId: t.teamId,
                    });
                    if (members == null) {
                        // Integration answered, but with nothing usable. Record
                        // it so the org is not retried forever.
                        empty += 1;
                        checkpoint[t.organizationId] = {
                            status: 'failed',
                            error: 'provider returned no member list',
                            at: new Date().toISOString(),
                        };
                    } else {
                        await persistCount(
                            args,
                            t.organizationId,
                            members.length,
                        );
                        ok += 1;
                        checkpoint[t.organizationId] = {
                            status: 'ok',
                            count: members.length,
                            at: new Date().toISOString(),
                        };
                        logger.log(
                            `✓ ${t.organizationName} (${t.platform}): ${members.length} members`,
                        );
                    }
                } catch (err) {
                    failed += 1;
                    const message =
                        err instanceof Error ? err.message : String(err);
                    const permanent = isPermanentFailure(message);
                    if (permanent) permanentCount += 1;
                    checkpoint[t.organizationId] = {
                        status: 'failed',
                        error: message,
                        ...(permanent ? { permanent: true } : {}),
                        at: new Date().toISOString(),
                    };
                    logger.error(
                        `✗ ${t.organizationName}${permanent ? ' [definitivo]' : ''}: ${message}`,
                    );
                }
                // Checkpoint after every org: the VPN can drop mid-run and the
                // next invocation must not redo work or re-hit the provider.
                writeCheckpoint(checkpoint);
            }
        };

        await Promise.all(
            Array.from({ length: args.concurrency }, () => worker()),
        );
    } finally {
        await app.close();
    }

    logger.log(
        `done — ${ok} persisted, ${empty} with no member list, ${failed} failed` +
            (permanentCount > 0
                ? ` (${permanentCount} definitivas: instalação removida/suspensa/revogada)`
                : ''),
    );
    logger.log(`checkpoint: ${CHECKPOINT_FILE}`);
    if (failed > 0) {
        logger.log('re-run with --retry-failed to retry the failures');
    }
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
