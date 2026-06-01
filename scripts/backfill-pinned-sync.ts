#!/usr/bin/env npx ts-node
/**
 * Backfill `pinnedSync` on existing Kody Rules.
 *
 * Why this exists:
 *   Rules created before the `pinnedSync` flag shipped have no value
 *   for it. The orphan-rules chip in the UI uses `pinnedSync=true` as
 *   the opt-out signal ("backend keeps syncing this via @kody-sync"),
 *   so pre-existing rules show up as "orphan" until the next time
 *   their source file is re-synced. For repos with auto-sync OFF that
 *   re-sync may never happen organically. This script triggers it
 *   per (org, repo) so the chip count converges to reality.
 *
 * What it does:
 *   For each selected (org, team, repo) it calls
 *   `KodyRulesSyncService.syncRepositoryMain` — the same code path
 *   the "Resync rules from IDE" button uses. With the depin pass
 *   shipped alongside `pinnedSync`, that sync:
 *     • sets `pinnedSync=true` on rules whose source file currently
 *       carries `@kody-sync`;
 *     • flips it to `false` on rules whose file lost the marker;
 *     • soft-deletes (status=DELETED) rules whose file is gone from
 *       the default branch.
 *
 *   Calling `syncRepositoryMain` re-extracts rule content via the
 *   LLM for any file that's in the force-sync set, so this is NOT
 *   strictly read-only — it can refresh rule.title/severity/etc.
 *   from the latest file content. Run with `--dry-run` first to
 *   review the target list before incurring those calls.
 *
 * Usage:
 *   # One repo of a specific org (most common — fix one customer)
 *   npx ts-node scripts/backfill-pinned-sync.ts \
 *     --org-id=<uuid> --repo-id=<repoId>
 *
 *   # All repos of a specific org with ideRulesSyncEnabled=false
 *   npx ts-node scripts/backfill-pinned-sync.ts --org-id=<uuid>
 *
 *   # Every org/repo that meets the condition (use with care — LLM cost)
 *   npx ts-node scripts/backfill-pinned-sync.ts --all
 *
 *   # Dry-run: print targets, don't sync
 *   npx ts-node scripts/backfill-pinned-sync.ts --all --dry-run
 *
 *   # Different env file
 *   npx ts-node scripts/backfill-pinned-sync.ts --all --env=.env.prod
 *
 * Required env: everything the Nest bootstrap needs (PG + Mongo +
 * the SCM provider credentials referenced indirectly via
 * `CodeManagementService`). Same set as running the API itself.
 */

import 'dotenv/config';
import 'reflect-metadata';

import * as path from 'path';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';

import { KodyRulesModule } from '@libs/kodyRules/modules/kodyRules.module';
import { KodyRulesSyncService } from '@libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

interface CliArgs {
    orgId?: string;
    repoId?: string;
    all: boolean;
    dryRun: boolean;
    envFile?: string;
}

interface Target {
    organizationId: string;
    teamId: string;
    repositoryId: string;
    repositoryName: string;
    ideRulesSyncEnabled: boolean;
}

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
        repoId: get('--repo-id'),
        all: argv.includes('--all'),
        dryRun: argv.includes('--dry-run'),
        envFile: get('--env'),
    };

    const selectors = [out.orgId ? 1 : 0, out.all ? 1 : 0].reduce(
        (a, b) => a + b,
        0,
    );
    if (selectors === 0) {
        throw new Error(
            'Provide one of: --org-id=<uuid> (with optional --repo-id), or --all',
        );
    }
    if (out.repoId && !out.orgId) {
        throw new Error('--repo-id must be combined with --org-id');
    }
    if (out.all && (out.orgId || out.repoId)) {
        throw new Error('--all cannot be combined with --org-id / --repo-id');
    }
    return out;
}

function loadEnvFile(envFile?: string): void {
    if (!envFile) return;
    // dotenv/config already loaded `.env` at import time. Apply a second
    // pass on the explicit file so its values override.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dotenv = require('dotenv') as typeof import('dotenv');
    const resolved = path.resolve(envFile);
    dotenv.config({ path: resolved, override: true });
    // eslint-disable-next-line no-console
    console.log(`[env] overlaid env file: ${resolved}`);
}

/**
 * Standalone module — pulls in just enough of the app to resolve
 * `KodyRulesSyncService`. Avoids importing the full HTTP/queue stack.
 */
@Module({
    imports: [KodyRulesModule],
})
class BackfillPinnedSyncModule {}

async function loadTargets(args: CliArgs): Promise<Target[]> {
    const pg = new Client({
        host: requireEnv('API_PG_DB_HOST'),
        port: Number(process.env.API_PG_DB_PORT ?? 5432),
        user: requireEnv('API_PG_DB_USERNAME'),
        password: requireEnv('API_PG_DB_PASSWORD'),
        database: requireEnv('API_PG_DB_DATABASE'),
        ssl:
            process.env.API_DATABASE_DISABLE_SSL === 'true'
                ? false
                : { rejectUnauthorized: false },
    });
    await pg.connect();

    const targets: Target[] = [];
    try {
        const whereOrg = args.orgId
            ? 'AND t.organization_id = $1'
            : '';
        const queryParams = args.orgId ? [args.orgId] : [];
        const { rows } = await pg.query(
            `SELECT t.organization_id AS "organizationId",
                    t.uuid AS "teamId",
                    p."configValue" AS "configValue"
             FROM parameters p
             JOIN teams t ON t.uuid = p.team_id
             WHERE p."configKey" = 'code_review_config'
               AND p.active = true
               ${whereOrg}`,
            queryParams,
        );

        for (const row of rows) {
            const repos = row.configValue?.repositories ?? [];
            for (const repo of repos) {
                if (!repo?.id) continue;
                // Only repos with the toggle OFF can have stale
                // `pinnedSync`. With the toggle ON the normal sync flow
                // already keeps things current on every PR.
                const toggleOn = repo?.configs?.ideRulesSyncEnabled === true;
                if (toggleOn) continue;
                if (args.repoId && String(repo.id) !== args.repoId) continue;
                targets.push({
                    organizationId: row.organizationId,
                    teamId: row.teamId,
                    repositoryId: String(repo.id),
                    repositoryName: repo.name ?? '(unknown)',
                    ideRulesSyncEnabled: false,
                });
            }
        }
    } finally {
        await pg.end();
    }
    return targets;
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
}

async function main() {
    const logger = new Logger('backfill-pinned-sync');
    const args = parseArgs();
    loadEnvFile(args.envFile);

    const targets = await loadTargets(args);
    if (targets.length === 0) {
        logger.log('no (org, repo) pairs matched the selector — nothing to do');
        return;
    }

    logger.log(`identified ${targets.length} (org, repo) target(s):`);
    for (const t of targets) {
        logger.log(
            `  org=${t.organizationId} team=${t.teamId} repo=${t.repositoryId} name=${t.repositoryName}`,
        );
    }

    if (args.dryRun) {
        logger.log('[DRY RUN] not calling syncRepositoryMain — exiting');
        return;
    }

    const app = await NestFactory.createApplicationContext(
        BackfillPinnedSyncModule,
        { logger: ['log', 'warn', 'error'] },
    );

    let succeeded = 0;
    let failed = 0;
    try {
        const sync = app.get(KodyRulesSyncService);
        for (const t of targets) {
            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId: t.organizationId,
                teamId: t.teamId,
            };
            try {
                await sync.syncRepositoryMain({
                    organizationAndTeamData,
                    repository: {
                        id: t.repositoryId,
                        name: t.repositoryName,
                    },
                });
                succeeded += 1;
                logger.log(
                    `✓ synced org=${t.organizationId} repo=${t.repositoryId}`,
                );
            } catch (err) {
                failed += 1;
                logger.error(
                    `✗ failed org=${t.organizationId} repo=${t.repositoryId}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }
    } finally {
        await app.close();
    }

    logger.log(
        `backfill complete — ${succeeded} succeeded, ${failed} failed of ${targets.length} target(s)`,
    );
    if (failed > 0) {
        process.exit(1);
    }
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('backfill-pinned-sync crashed:', err);
    process.exit(1);
});
